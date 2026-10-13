"""Fail-closed Docker CLI boundary for disposable code evaluation.

This module is a construction scaffold, not a security certification. A Docker
daemon/VM, image audit, host configuration review, and adversarial isolation
testing are still required before this can safely execute generated code.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import stat
import sys
import threading
import time
import uuid
from typing import Iterator, Protocol


class EvaluationError(RuntimeError):
    """The evaluator could not complete while preserving its policy."""


_PINNED_IMAGE = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$"
)
_CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
_CONTAINER_ID_PREFIX = re.compile(r"^[0-9a-f]{12,64}$")
_NAME = re.compile(r"^guru-eval-[0-9a-f]{32}$")
_MANAGED_LABEL = "io.brahmini.guru.evaluator-managed"
_MANAGED_LABEL_VALUE = "v1"
_OWNER_LABEL = "io.brahmini.guru.evaluator-owner"
_OWNER_TOKEN = re.compile(r"^[0-9a-f]{64}$")
_DOCKER_NONE_NETWORK = {
    "IPAMConfig": None,
    "Links": None,
    "Aliases": None,
    "MacAddress": "",
    "DriverOpts": None,
    "GwPriority": 0,
    "NetworkID": "",
    "EndpointID": "",
    "Gateway": "",
    "IPAddress": "",
    "IPPrefixLen": 0,
    "IPv6Gateway": "",
    "GlobalIPv6Address": "",
    "GlobalIPv6PrefixLen": 0,
    "DNSNames": None,
}
_LOCK_FILENAME = "docker-evaluator.lock"
_OWNER_TOKEN_FILENAME = "docker-evaluator.owner"
DOCKER_ENGINE_RECOVERY_VERSION = "guru-docker-engine-recovery-v1"


def _default_state_directory(installation_root: str | os.PathLike[str] | None = None) -> Path:
    """Return durable, per-user and per-checkout evaluator recovery state."""
    root = Path(installation_root or Path(__file__).resolve().parents[1]).resolve()
    installation_id = hashlib.sha256(os.fsencode(str(root))).hexdigest()
    if sys.platform == "darwin":
        state_home = Path.home() / "Library" / "Application Support" / "Brahmini" / "GuruEvaluator"
    else:
        state_home = Path.home() / ".local" / "state" / "brahmini" / "guru-evaluator"
    return state_home / installation_id


@dataclass(frozen=True)
class EvaluationPolicy:
    image: str
    command: tuple[str, ...]
    timeout_seconds: float = 10.0
    memory_bytes: int = 512 * 1024 * 1024
    cpu_count: float = 1.0
    pids_limit: int = 128
    tmpfs_bytes: int = 64 * 1024 * 1024
    input_limit_bytes: int = 1024 * 1024
    output_limit_bytes: int = 64 * 1024
    control_timeout_seconds: float = 5.0

    def __post_init__(self):
        if not isinstance(self.image, str) or not _PINNED_IMAGE.fullmatch(self.image):
            raise ValueError("image must be pinned by sha256 digest")
        if not self.command or any(not isinstance(x, str) or not x or "\x00" in x for x in self.command):
            raise ValueError("command must be a non-empty fixed argv tuple")
        if any(x.startswith("--") and x.split("=", 1)[0] in {"--network", "--mount", "--volume", "--privileged", "--device", "--env", "--env-file", "--pid", "--ipc", "--userns", "--runtime"} for x in self.command):
            raise ValueError("runner command cannot override container isolation policy")
        if not (0 < self.timeout_seconds <= 300):
            raise ValueError("timeout_seconds must be in (0, 300]")
        if not (16 * 1024 * 1024 <= self.memory_bytes <= 8 * 1024**3):
            raise ValueError("memory_bytes is outside the supported safe range")
        if not (0 < self.cpu_count <= 8):
            raise ValueError("cpu_count must be in (0, 8]")
        if not (1 <= self.pids_limit <= 4096):
            raise ValueError("pids_limit must be in [1, 4096]")
        if not (1024 * 1024 <= self.tmpfs_bytes <= 1024**3):
            raise ValueError("tmpfs_bytes is outside the supported safe range")
        if not (0 <= self.input_limit_bytes <= 16 * 1024**2):
            raise ValueError("input_limit_bytes is outside the supported safe range")
        if not (1024 <= self.output_limit_bytes <= 1024**2):
            raise ValueError("output_limit_bytes is outside the supported safe range")
        if not (0 < self.control_timeout_seconds <= 30):
            raise ValueError("control_timeout_seconds must be in (0, 30]")


@dataclass(frozen=True)
class EngineResult:
    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False
    output_limited: bool = False


@dataclass(frozen=True)
class EvaluationEvidence:
    image: str
    input_sha256: str
    exit_code: int | None
    timed_out: bool
    output_limited: bool
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    elapsed_ms: int
    container_removed: bool


class ContainerEngine(Protocol):
    def create(self, policy: EvaluationPolicy, name: str) -> str: ...
    def start(self, container_id: str, payload: bytes, policy: EvaluationPolicy) -> EngineResult: ...
    def remove(self, container_id: str, policy: EvaluationPolicy) -> None: ...


def _docker_options(policy: EvaluationPolicy, name: str, *, owner_token: str) -> list[str]:
    if not _NAME.fullmatch(name):
        raise ValueError("invalid evaluator container name")
    if not _OWNER_TOKEN.fullmatch(owner_token):
        raise ValueError("invalid evaluator owner token")
    memory = str(policy.memory_bytes)
    return [
        "create", "--interactive", "--name", name,
        "--label", f"{_MANAGED_LABEL}={_MANAGED_LABEL_VALUE}",
        "--label", f"{_OWNER_LABEL}={owner_token}", "--log-driver", "none",
        "--network", "none", "--cgroupns", "private", "--read-only", "--user", "65534:65534",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", str(policy.pids_limit), "--memory", memory,
        "--memory-swap", memory, "--cpus", str(policy.cpu_count),
        "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={policy.tmpfs_bytes},mode=1777",
        # No bind/volume mounts, environment injection, host PID/IPC, devices, or credentials.
        policy.image, *policy.command,
    ]


class DockerCliEngine:
    """Docker CLI adapter pinned to one explicit local Unix socket.

    The socket must be selected and qualified by a trusted caller. Endpoint
    overrides are removed from the child environment and every CLI call uses
    ``--host`` so a later Docker context switch cannot redirect execution.
    This primitive remains a probe/test boundary, not evaluator qualification.
    """

    def __init__(
        self, endpoint: str, executable: str = "docker", *,
        state_directory: str | os.PathLike[str] | None = None,
        installation_root: str | os.PathLike[str] | None = None,
    ):
        if not executable or "\x00" in executable:
            raise ValueError("docker executable must be a non-empty path")
        if not isinstance(endpoint, str) or not endpoint.startswith("unix:///") or "\x00" in endpoint:
            raise ValueError("endpoint must be an explicit local Unix socket URI")
        self.endpoint = endpoint
        self.executable = executable
        if state_directory is not None and installation_root is not None:
            raise ValueError("choose state_directory or installation_root, not both")
        self.state_directory = (
            Path(state_directory) if state_directory is not None
            else _default_state_directory(installation_root)
        )
        self._scope_guard = threading.Lock()
        self._scope_reserved = False
        self._scope_owner_thread: int | None = None

    @contextmanager
    def evaluation_scope(self, policy: EvaluationPolicy) -> Iterator[None]:
        """Serialize local evaluator lifecycles and reap abandoned workers.

        The advisory lock is held across stale-worker cleanup, create, start,
        and removal. A process crash releases the OS lock; the next process can
        then remove only containers carrying Guru's dedicated ownership label.
        This recovery mechanism is not proof of Docker/VM isolation.
        """
        with self._scope_guard:
            if self._scope_reserved:
                raise EvaluationError("Docker engine already has an active evaluator lifecycle")
            self._scope_reserved = True
        descriptor: int | None = None
        locked = False
        try:
            descriptor = self._open_evaluator_lock()
            deadline = time.monotonic() + policy.control_timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                    break
                except BlockingIOError as exc:
                    if time.monotonic() >= deadline:
                        raise EvaluationError("another local evaluator lifecycle did not release its lock") from exc
                    time.sleep(0.05)
            self._reap_abandoned_containers(policy)
            with self._scope_guard:
                self._scope_owner_thread = threading.get_ident()
            try:
                yield
            finally:
                with self._scope_guard:
                    self._scope_owner_thread = None
        finally:
            if descriptor is not None:
                if locked:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)
            with self._scope_guard:
                self._scope_reserved = False

    def _open_evaluator_lock(self) -> int:
        """Open a private local lock file without following symlinks."""
        try:
            self.state_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory_stat = self.state_directory.lstat()
            if (not self.state_directory.is_dir() or self.state_directory.is_symlink() or
                    directory_stat.st_uid != os.getuid() or directory_stat.st_mode & 0o077):
                raise EvaluationError("evaluator state directory is not private and owner-controlled")
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(self.state_directory / _LOCK_FILENAME, flags, 0o600)
            file_stat = os.fstat(descriptor)
            if (not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.getuid() or
                    file_stat.st_nlink != 1):
                os.close(descriptor)
                raise EvaluationError("evaluator lock is not a private owner-controlled regular file")
            os.fchmod(descriptor, 0o600)
            return descriptor
        except EvaluationError:
            raise
        except OSError as exc:
            raise EvaluationError("cannot open private evaluator lifecycle lock") from exc

    def _owner_token(self) -> str:
        """Read or create the random identity for this private evaluator install."""
        try:
            self.state_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory_stat = self.state_directory.lstat()
            if (not self.state_directory.is_dir() or self.state_directory.is_symlink() or
                    directory_stat.st_uid != os.getuid() or directory_stat.st_mode & 0o077):
                raise EvaluationError("evaluator state directory is not private and owner-controlled")
            path = self.state_directory / _OWNER_TOKEN_FILENAME
            try:
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            except FileNotFoundError:
                token = secrets.token_hex(32)
                flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
                try:
                    descriptor = os.open(path, flags, 0o600)
                except FileExistsError:
                    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                else:
                    try:
                        token_bytes = token.encode("ascii")
                        written = 0
                        while written < len(token_bytes):
                            written += os.write(descriptor, token_bytes[written:])
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    directory_fd = os.open(self.state_directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                    return token
            try:
                file_stat = os.fstat(descriptor)
                if (not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.getuid() or
                        file_stat.st_nlink != 1 or file_stat.st_mode & 0o077):
                    raise EvaluationError("evaluator owner token is not private and owner-controlled")
                contents = os.read(descriptor, 128)
            finally:
                os.close(descriptor)
            token = contents.decode("ascii", "strict")
            if not _OWNER_TOKEN.fullmatch(token):
                raise EvaluationError("evaluator owner token is malformed")
            return token
        except EvaluationError:
            raise
        except (OSError, UnicodeError) as exc:
            raise EvaluationError("cannot verify private evaluator owner token") from exc

    def _reap_abandoned_containers(self, policy: EvaluationPolicy) -> None:
        """Remove only containers carrying the exact evaluator ownership label."""
        try:
            owner_token = self._owner_token()
            response = self._control([
                "ps", "--all", "--filter", f"label={_MANAGED_LABEL}={_MANAGED_LABEL_VALUE}",
                "--filter", f"label={_OWNER_LABEL}={owner_token}",
                "--format", "{{.ID}}|{{.Names}}",
            ], policy.control_timeout_seconds)
            entries = response.stdout.decode("ascii", "strict").splitlines()
            if len(entries) > 512:
                raise EvaluationError("managed evaluator container inventory exceeded limit")
            for entry in entries:
                parts = entry.split("|")
                if (len(parts) != 2 or not _CONTAINER_ID_PREFIX.fullmatch(parts[0]) or
                        not _NAME.fullmatch(parts[1])):
                    raise EvaluationError("managed evaluator inventory contained an invalid identifier")
                identifier, name = parts
                inspected = self._control([
                    "inspect", "--format", "{{json .Config.Labels}}", identifier,
                ], policy.control_timeout_seconds)
                labels = json.loads(inspected.stdout.decode("utf-8", "strict"))
                if not isinstance(labels, dict):
                    raise EvaluationError("managed evaluator labels are unavailable")
                if (labels.get(_MANAGED_LABEL) != _MANAGED_LABEL_VALUE or
                        labels.get(_OWNER_LABEL) != owner_token or
                        labels.get("com.docker.compose.project") is not None):
                    # Recheck exact owner and isolate only Guru-named workers.
                    continue
                self._control(["rm", "--force", "--volumes", identifier], policy.control_timeout_seconds)
        except EvaluationError:
            raise
        except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise EvaluationError("managed evaluator inventory could not be verified") from exc

    def _argv(self, args: list[str]) -> list[str]:
        return [self.executable, "--host", self.endpoint, *args]

    def _require_evaluation_scope(self) -> None:
        with self._scope_guard:
            owns_scope = self._scope_owner_thread == threading.get_ident()
        if not owns_scope:
            raise EvaluationError("Docker engine operations require an active evaluator lifecycle")

    @staticmethod
    def _environment() -> dict[str, str]:
        env = os.environ.copy()
        # Keep endpoint resolution tied to the explicit --host argument above.
        for name in ("DOCKER_HOST", "DOCKER_CONTEXT"):
            env.pop(name, None)
        return env

    def _control(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
        try:
            proc = subprocess.Popen(
                self._argv(args), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, close_fds=True,
                env=self._environment(),
            )
        except OSError as exc:
            raise EvaluationError("Docker control operation could not start") from exc

        captured = {"stdout": bytearray(), "stderr": bytearray()}
        lock = threading.Lock()
        overflow = threading.Event()

        def read_control(stream, key):
            while True:
                chunk = stream.read(2048)
                if not chunk:
                    return
                with lock:
                    remaining = 8192 - sum(map(len, captured.values()))
                    if remaining > 0:
                        captured[key].extend(chunk[:remaining])
                    if len(chunk) > max(remaining, 0):
                        overflow.set()
                if overflow.is_set():
                    try:
                        proc.kill()
                    except OSError:
                        pass
                    return

        readers = [
            threading.Thread(target=read_control, args=(proc.stdout, "stdout"), daemon=True),
            threading.Thread(target=read_control, args=(proc.stderr, "stderr"), daemon=True),
        ]
        for thread in readers:
            thread.start()
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            proc.wait()
        finally:
            for thread in readers:
                thread.join(timeout=1)
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        if timed_out:
            raise EvaluationError("Docker control operation timed out")
        if overflow.is_set():
            raise EvaluationError("Docker control response exceeded bound")
        with lock:
            result = subprocess.CompletedProcess(
                args=self._argv(args), returncode=proc.returncode,
                stdout=bytes(captured["stdout"]), stderr=bytes(captured["stderr"]),
            )
        if result.returncode:
            raise EvaluationError("Docker control operation returned failure")
        return result

    def _inspect_created_container(self, container_id: str, policy: EvaluationPolicy) -> None:
        """Verify exact container ownership and effective isolation settings.

        The full ID is used for each inspect. A network, mount or logging
        policy mismatch is a hard failure; cleanup separately rechecks
        ownership before removal.
        """
        if not _CONTAINER_ID.fullmatch(container_id):
            raise EvaluationError("invalid container identifier during inspection")
        try:
            labels_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .Config.Labels}}", container_id,
            ], policy.control_timeout_seconds)
            labels = json.loads(labels_result.stdout.decode("utf-8", "strict"))
            owner_token = self._owner_token()
            if not isinstance(labels, dict):
                raise EvaluationError("created evaluator container labels are unavailable")
            owned = (
                labels.get(_MANAGED_LABEL) == _MANAGED_LABEL_VALUE
                and labels.get(_OWNER_LABEL) == owner_token
                and labels.get("com.docker.compose.project") is None
            )
            if not owned:
                raise EvaluationError("created evaluator container ownership could not be verified")
            network_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .HostConfig.NetworkMode}}", container_id,
            ], policy.control_timeout_seconds)
            network_mode = json.loads(network_result.stdout.decode("utf-8", "strict"))
            if network_mode != "none":
                raise EvaluationError("created evaluator container network policy is not none")
            networks_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .NetworkSettings.Networks}}", container_id,
            ], policy.control_timeout_seconds)
            networks = json.loads(networks_result.stdout.decode("utf-8", "strict"))
            no_network_attachment = (
                networks == {}
                or (isinstance(networks, dict)
                    and set(networks) == {"none"}
                    and networks["none"] == _DOCKER_NONE_NETWORK)
            )
            if not no_network_attachment:
                raise EvaluationError("created evaluator container has an external network attachment")
            mounts_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .Mounts}}", container_id,
            ], policy.control_timeout_seconds)
            mounts = json.loads(mounts_result.stdout.decode("utf-8", "strict"))
            # Before start, Docker does not materialize the requested tmpfs in
            # Mounts. Verify all declarative mount sources and the eventual
            # tmpfs policy separately instead of expecting a runtime mount.
            if mounts != []:
                raise EvaluationError("created evaluator container mount policy is not isolated")
            for inspect_format, empty_values in (
                ("{{json .HostConfig.Binds}}", (None, [])),
                ("{{json .HostConfig.Mounts}}", (None, [])),
                ("{{json .HostConfig.VolumesFrom}}", (None, [])),
                ("{{json .Config.Volumes}}", (None, {})),
            ):
                field_result = self._control([
                    "inspect", "--type", "container", "--format", inspect_format, container_id,
                ], policy.control_timeout_seconds)
                field_value = json.loads(field_result.stdout.decode("utf-8", "strict"))
                if field_value not in empty_values:
                    raise EvaluationError("created evaluator container mount policy is not isolated")
            host_config_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .HostConfig}}", container_id,
            ], policy.control_timeout_seconds)
            host_config = json.loads(host_config_result.stdout.decode("utf-8", "strict"))
            expected_host_config = {
                "CapAdd": None,
                "CapDrop": ["ALL"],
                "CpuPeriod": 0,
                "CpuShares": 0,
                "CpuQuota": 0,
                "NanoCpus": int(round(policy.cpu_count * 1_000_000_000)),
                "Memory": policy.memory_bytes,
                "MemorySwap": policy.memory_bytes,
                "PidsLimit": policy.pids_limit,
                "CgroupnsMode": "private",
                "Privileged": False,
                "ReadonlyRootfs": True,
                "SecurityOpt": ["no-new-privileges"],
                "IpcMode": "private",
                "PidMode": "",
                "UTSMode": "",
                "Devices": [],
                "DeviceRequests": None,
                "Tmpfs": {
                    "/tmp": f"rw,noexec,nosuid,nodev,size={policy.tmpfs_bytes},mode=1777",
                },
            }
            if not isinstance(host_config, dict):
                raise EvaluationError("created evaluator container security/resource settings are unavailable")
            device_cgroup_rules = host_config.get("DeviceCgroupRules")
            if ("DeviceCgroupRules" not in host_config
                    or device_cgroup_rules not in (None, [])):
                raise EvaluationError("created evaluator container DeviceCgroupRules must be empty")
            for field, expected in expected_host_config.items():
                actual = host_config.get(field)
                if field not in host_config or type(actual) is not type(expected) or actual != expected:
                    raise EvaluationError(
                        f"created evaluator container security/resource policy mismatch: {field}"
                    )
            user_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .Config.User}}", container_id,
            ], policy.control_timeout_seconds)
            config_user = json.loads(user_result.stdout.decode("utf-8", "strict"))
            if not isinstance(config_user, str) or config_user != "65534:65534":
                raise EvaluationError("created evaluator container user is not the restricted UID/GID")
            log_result = self._control([
                "inspect", "--type", "container", "--format", "{{json .HostConfig.LogConfig}}", container_id,
            ], policy.control_timeout_seconds)
            path_result = self._control([
                "inspect", "--type", "container", "--format", "{{.LogPath}}", container_id,
            ], policy.control_timeout_seconds)
            log_config = json.loads(log_result.stdout.decode("utf-8", "strict"))
            log_path = path_result.stdout.decode("utf-8", "strict").strip()
            if not isinstance(log_config, dict) or log_config.get("Type") != "none" or log_path:
                raise EvaluationError("created evaluator container logging policy is not none")
            return
        except EvaluationError:
            raise
        except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise EvaluationError("created evaluator container inspection could not be verified") from exc

    def _remove_after_verified_owner(self, container_id: str, policy: EvaluationPolicy) -> None:
        """Best-effort cleanup only after a fresh exact-ID owner-label check."""
        try:
            # Re-inspect ownership before cleaning up any container whose
            # effective isolation policy failed verification.
            result = self._control([
                "inspect", "--type", "container", "--format", "{{json .Config.Labels}}",
                container_id,
            ], policy.control_timeout_seconds)
            labels = json.loads(result.stdout.decode("utf-8", "strict"))
            owner_token = self._owner_token()
            if (isinstance(labels, dict)
                    and labels.get(_MANAGED_LABEL) == _MANAGED_LABEL_VALUE
                    and labels.get(_OWNER_LABEL) == owner_token
                    and labels.get("com.docker.compose.project") is None):
                self._control(["rm", "--force", "--volumes", container_id], policy.control_timeout_seconds)
        except (EvaluationError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
            # Leave uncertain containers for the next locked recovery pass.
            return

    def create(self, policy: EvaluationPolicy, name: str) -> str:
        self._require_evaluation_scope()
        result = self._control(
            _docker_options(policy, name, owner_token=self._owner_token()),
            policy.control_timeout_seconds,
        )
        container_id = result.stdout.decode("ascii", "strict").strip()
        if not _CONTAINER_ID.fullmatch(container_id):
            # Do not remove by an unverified name. If create reached the daemon
            # before the control response failed, the next locked startup pass
            # will discover and clean the exact owner-labeled container.
            raise EvaluationError("Docker create returned an invalid container identifier")
        try:
            self._inspect_created_container(container_id, policy)
        except EvaluationError:
            self._remove_after_verified_owner(container_id, policy)
            raise
        return container_id

    def start(self, container_id: str, payload: bytes, policy: EvaluationPolicy) -> EngineResult:
        self._require_evaluation_scope()
        if not _CONTAINER_ID.fullmatch(container_id):
            raise EvaluationError("invalid container identifier")
        # Recheck immediately before start to close the create/inspect/start
        # gap as far as the Docker CLI boundary permits.
        self._inspect_created_container(container_id, policy)
        try:
            proc = subprocess.Popen(
                self._argv(["start", "--attach", "--interactive", container_id]),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                shell=False, close_fds=True, env=self._environment(),
            )
        except OSError as exc:
            raise EvaluationError("could not start evaluator container") from exc

        output = {"stdout": bytearray(), "stderr": bytearray()}
        lock = threading.Lock()
        limited = threading.Event()

        def read_bounded(stream, key):
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    return
                with lock:
                    remaining = policy.output_limit_bytes - sum(map(len, output.values()))
                    if remaining > 0:
                        output[key].extend(chunk[:remaining])
                    if len(chunk) > max(remaining, 0):
                        limited.set()
                if limited.is_set():
                    try:
                        proc.kill()
                    except OSError:
                        pass
                    return

        def write_input():
            try:
                assert proc.stdin is not None
                proc.stdin.write(payload)
                proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            finally:
                if proc.stdin:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass

        readers = [
            threading.Thread(target=read_bounded, args=(proc.stdout, "stdout"), daemon=True),
            threading.Thread(target=read_bounded, args=(proc.stderr, "stderr"), daemon=True),
        ]
        for thread in readers:
            thread.start()
        writer = threading.Thread(target=write_input, daemon=True)
        writer.start()
        timed_out = False
        try:
            proc.wait(timeout=policy.timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            proc.wait()
        finally:
            writer.join(timeout=1)
            for thread in readers:
                thread.join(timeout=1)
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        with lock:
            out = bytes(output["stdout"])
            err = bytes(output["stderr"])
        return EngineResult(proc.returncode if proc.returncode is not None else -1, out, err, timed_out, limited.is_set())

    def remove(self, container_id: str, policy: EvaluationPolicy) -> None:
        self._require_evaluation_scope()
        if not _CONTAINER_ID.fullmatch(container_id):
            raise EvaluationError("invalid container identifier during cleanup")
        self._control(["rm", "--force", "--volumes", container_id], policy.control_timeout_seconds)


def _evaluate_with_engine(
    payload: bytes, policy: EvaluationPolicy, engine: ContainerEngine,
) -> EvaluationEvidence:
    """Internal engine adapter for synthetic tests and probe wiring."""
    if not isinstance(payload, bytes):
        raise TypeError("payload must be bytes")
    if len(payload) > policy.input_limit_bytes:
        raise EvaluationError("evaluation input exceeds policy limit")
    started = time.monotonic()
    container_id: str | None = None
    result: EngineResult | None = None
    removed = False
    scope_factory = getattr(engine, "evaluation_scope", None)
    scope = scope_factory(policy) if callable(scope_factory) else nullcontext()
    with scope:
        try:
            container_id = engine.create(policy, "guru-eval-" + uuid.uuid4().hex)
            if not _CONTAINER_ID.fullmatch(container_id):
                raise EvaluationError("engine returned an invalid container identifier")
            result = engine.start(container_id, payload, policy)
        finally:
            if container_id is not None:
                engine.remove(container_id, policy)
                removed = True
    assert result is not None
    stdout = result.stdout[:policy.output_limit_bytes]
    stderr = result.stderr[:max(0, policy.output_limit_bytes - len(stdout))]
    return EvaluationEvidence(
        image=policy.image, input_sha256=hashlib.sha256(payload).hexdigest(),
        exit_code=result.exit_code, timed_out=result.timed_out,
        output_limited=result.output_limited, stdout=stdout, stderr=stderr,
        # output_limited is aggregate; either stream may have lost trailing data.
        stdout_truncated=result.output_limited or len(result.stdout) > len(stdout),
        stderr_truncated=result.output_limited or len(result.stderr) > len(stderr),
        elapsed_ms=int((time.monotonic() - started) * 1000), container_removed=removed,
    )


def evaluate(
    payload: bytes, policy: EvaluationPolicy, *, local_endpoint: str | None = None,
) -> EvaluationEvidence:
    """Run an opaque probe payload on an explicitly pinned local Docker socket.

    Engine injection is intentionally absent from this public entry point.
    Synthetic unit tests use the private ``_evaluate_with_engine`` helper.
    """
    if local_endpoint is None:
        raise EvaluationError("explicit local Docker endpoint is required")
    try:
        engine = DockerCliEngine(endpoint=local_endpoint)
    except (TypeError, ValueError) as exc:
        raise EvaluationError("Docker endpoint must be an explicit local Unix socket") from exc
    return _evaluate_with_engine(payload, policy, engine)
