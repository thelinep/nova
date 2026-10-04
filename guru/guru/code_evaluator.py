"""Fail-closed Docker CLI boundary for disposable code evaluation.

This module is a construction scaffold, not a security certification. A Docker
daemon/VM, image audit, host configuration review, and adversarial isolation
testing are still required before this can safely execute generated code.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
import subprocess
import threading
import time
import uuid
from typing import Protocol


class EvaluationError(RuntimeError):
    """The evaluator could not complete while preserving its policy."""


_PINNED_IMAGE = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$"
)
_CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
_NAME = re.compile(r"^guru-eval-[0-9a-f]{32}$")


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


def _docker_options(policy: EvaluationPolicy, name: str) -> list[str]:
    if not _NAME.fullmatch(name):
        raise ValueError("invalid evaluator container name")
    memory = str(policy.memory_bytes)
    return [
        "create", "--interactive", "--name", name,
        "--network", "none", "--read-only", "--user", "65534:65534",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", str(policy.pids_limit), "--memory", memory,
        "--memory-swap", memory, "--cpus", str(policy.cpu_count),
        "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={policy.tmpfs_bytes},mode=1777",
        # No bind/volume mounts, environment injection, host PID/IPC, devices, or credentials.
        policy.image, *policy.command,
    ]


class DockerCliEngine:
    """Minimal Docker CLI adapter; its guarantees depend on daemon/VM setup."""

    def __init__(self, executable: str = "docker"):
        if not executable or "\x00" in executable:
            raise ValueError("docker executable must be a non-empty path")
        self.executable = executable

    def _control(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
        try:
            proc = subprocess.Popen(
                [self.executable, *args], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, close_fds=True,
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
                args=[self.executable, *args], returncode=proc.returncode,
                stdout=bytes(captured["stdout"]), stderr=bytes(captured["stderr"]),
            )
        if result.returncode:
            raise EvaluationError("Docker control operation returned failure")
        return result

    def create(self, policy: EvaluationPolicy, name: str) -> str:
        try:
            result = self._control(_docker_options(policy, name), policy.control_timeout_seconds)
        except BaseException as create_error:
            # A control-client timeout can occur after the daemon has created
            # the named container. Best-effort cleanup is required before
            # propagating the original failure.
            try:
                self._control(["rm", "--force", "--volumes", name], policy.control_timeout_seconds)
            except BaseException as cleanup_error:
                raise EvaluationError("container create failed and named-container cleanup failed") from cleanup_error
            raise create_error
        container_id = result.stdout.decode("ascii", "strict").strip()
        if not _CONTAINER_ID.fullmatch(container_id):
            # Remove by our generated name if the daemon created a container but
            # returned malformed output; cleanup failure is deliberately surfaced.
            self._control(["rm", "--force", "--volumes", name], policy.control_timeout_seconds)
            raise EvaluationError("Docker create returned an invalid container identifier")
        return container_id

    def start(self, container_id: str, payload: bytes, policy: EvaluationPolicy) -> EngineResult:
        if not _CONTAINER_ID.fullmatch(container_id):
            raise EvaluationError("invalid container identifier")
        try:
            proc = subprocess.Popen(
                [self.executable, "start", "--attach", "--interactive", container_id],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                shell=False, close_fds=True,
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
        if not _CONTAINER_ID.fullmatch(container_id):
            raise EvaluationError("invalid container identifier during cleanup")
        self._control(["rm", "--force", "--volumes", container_id], policy.control_timeout_seconds)


def evaluate(payload: bytes, policy: EvaluationPolicy, engine: ContainerEngine | None = None) -> EvaluationEvidence:
    """Evaluate opaque bytes; callers must supply a reviewed runner payload format."""
    if not isinstance(payload, bytes):
        raise TypeError("payload must be bytes")
    if len(payload) > policy.input_limit_bytes:
        raise EvaluationError("evaluation input exceeds policy limit")
    engine = engine or DockerCliEngine()
    started = time.monotonic()
    container_id: str | None = None
    result: EngineResult | None = None
    removed = False
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
