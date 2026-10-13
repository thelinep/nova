"""Mock-only tests for evaluator policy and lifecycle (not isolation tests)."""
import os
import sys
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.code_evaluator import (
    DockerCliEngine, EngineResult, EvaluationError, EvaluationPolicy,
    evaluate, _default_state_directory, _docker_options, _evaluate_with_engine,
)


IMAGE = "registry.example.invalid/guru-runner@sha256:" + "a" * 64
CONTAINER_ID = "b" * 64
LOCAL_ENDPOINT = "unix:///var/run/docker.sock"


class FakeEngine:
    def __init__(self, result=None, fail_start=False, fail_remove=False):
        self.result = result or EngineResult(0, b"ok", b"")
        self.fail_start = fail_start
        self.fail_remove = fail_remove
        self.created = []
        self.started = []
        self.removed = []

    def create(self, policy, name):
        self.created.append((policy, name))
        return CONTAINER_ID

    def start(self, container_id, payload, policy):
        self.started.append((container_id, payload))
        if self.fail_start:
            raise RuntimeError("mock start failure")
        return self.result

    def remove(self, container_id, policy):
        self.removed.append(container_id)
        if self.fail_remove:
            raise RuntimeError("mock cleanup failure")


def policy(**overrides):
    values = {"image": IMAGE, "command": ("/opt/runner", "--stdin-json")}
    values.update(overrides)
    return EvaluationPolicy(**values)


def _completed(stdout):
    return subprocess.CompletedProcess([], 0, stdout, b"")


def _effective_host_config(current_policy=None):
    current_policy = current_policy or policy()
    return {
        "CapAdd": None, "CapDrop": ["ALL"],
        "CpuPeriod": 0, "CpuShares": 0, "CpuQuota": 0,
        "NanoCpus": int(round(current_policy.cpu_count * 1_000_000_000)),
        "Memory": current_policy.memory_bytes, "MemorySwap": current_policy.memory_bytes,
        "PidsLimit": current_policy.pids_limit, "CgroupnsMode": "private",
        "Privileged": False, "ReadonlyRootfs": True,
        "SecurityOpt": ["no-new-privileges"],
        "IpcMode": "private", "PidMode": "", "UTSMode": "",
        "Devices": [], "DeviceRequests": None, "DeviceCgroupRules": None,
        "Tmpfs": {
            "/tmp": f"rw,noexec,nosuid,nodev,size={current_policy.tmpfs_bytes},mode=1777",
        },
    }


def _container_inspection_responses(
    *, network_mode="none", networks=None, mounts=None, binds=None,
    host_mounts=None, volumes_from=None, config_volumes=None,
    host_config=None, config_user="65534:65534", log_type="none", log_path=b"",
    current_policy=None,
):
    current_policy = current_policy or policy()
    labels = json.dumps({
        "io.brahmini.guru.evaluator-managed": "v1",
        "io.brahmini.guru.evaluator-owner": "f" * 64,
    }).encode()
    if networks is None:
        networks = {"none": {
            "IPAMConfig": None, "Links": None, "Aliases": None, "MacAddress": "",
            "DriverOpts": None, "GwPriority": 0, "NetworkID": "", "EndpointID": "",
            "Gateway": "", "IPAddress": "", "IPPrefixLen": 0, "IPv6Gateway": "",
            "GlobalIPv6Address": "", "GlobalIPv6PrefixLen": 0, "DNSNames": None,
        }}
    if mounts is None:
        mounts = []
    if host_config is None:
        host_config = _effective_host_config(current_policy)
    network_response = network_mode if isinstance(network_mode, bytes) else json.dumps(network_mode).encode()
    networks_response = networks if isinstance(networks, bytes) else json.dumps(networks).encode()
    mounts_response = mounts if isinstance(mounts, bytes) else json.dumps(mounts).encode()
    binds_response = json.dumps(binds).encode()
    host_mounts_response = json.dumps(host_mounts).encode()
    volumes_from_response = json.dumps(volumes_from).encode()
    config_volumes_response = json.dumps(config_volumes).encode()
    host_config_response = host_config if isinstance(host_config, bytes) else json.dumps(host_config).encode()
    config_user_response = config_user if isinstance(config_user, bytes) else json.dumps(config_user).encode()
    log_config = json.dumps({"Type": log_type, "Config": {}}).encode()
    return [
        _completed(labels), _completed(network_response), _completed(networks_response),
        _completed(mounts_response), _completed(binds_response), _completed(host_mounts_response),
        _completed(volumes_from_response), _completed(config_volumes_response),
        _completed(host_config_response), _completed(config_user_response),
        _completed(log_config), _completed(log_path),
    ]


class EvaluationPolicyTests(unittest.TestCase):
    def test_requires_digest_pinned_image(self):
        for image in ("latest", "repo/image:tag", "repo/image@sha256:short"):
            with self.subTest(image=image), self.assertRaises(ValueError):
                policy(image=image)

    def test_rejects_unsafe_or_unbounded_policy_values(self):
        for kwargs in ({"timeout_seconds": 301}, {"memory_bytes": 10},
                       {"cpu_count": 0}, {"pids_limit": 0},
                       {"input_limit_bytes": 17 * 1024**2}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                policy(**kwargs)

    def test_constructed_container_has_no_network_mounts_or_credentials(self):
        args = _docker_options(
            policy(), "guru-eval-" + "c" * 32, owner_token="f" * 64,
        )
        self.assertIn("none", args)
        self.assertEqual(args[args.index("--cgroupns") + 1], "private")
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop", args)
        self.assertIn("ALL", args)
        self.assertIn("no-new-privileges", args)
        self.assertIn("--memory-swap", args)
        self.assertIn("--pids-limit", args)
        self.assertIn("--tmpfs", args)
        self.assertIn("--log-driver", args)
        self.assertIn("--label", args)
        self.assertIn("io.brahmini.guru.evaluator-managed=v1", args)
        self.assertIn("io.brahmini.guru.evaluator-owner=" + "f" * 64, args)
        self.assertIn("none", args)
        self.assertEqual(args[args.index("--log-driver") + 1], "none")
        self.assertFalse(any(x in {"--mount", "-v", "--volume", "--env", "-e", "--env-file", "--privileged", "--device"} for x in args))
        self.assertFalse(any("secret" in x.lower() or "token" in x.lower() for x in args))

    def test_fixed_probe_policy_overrides_image_entrypoint(self):
        fixed = EvaluationPolicy(
            image=policy().image, command=("-I", "-c", "print('fixed')"),
            entrypoint="/usr/local/bin/python",
        )
        args = _docker_options(
            fixed, "guru-eval-" + "c" * 32, owner_token="f" * 64,
        )
        self.assertEqual(args[args.index("--entrypoint") + 1], "/usr/local/bin/python")
        entrypoint_index = args.index("--entrypoint")
        image_index = args.index(fixed.image)
        self.assertLess(entrypoint_index, image_index)
        self.assertEqual(args[image_index + 1:], list(fixed.command))

    def test_rejects_invalid_generated_name_before_docker_call(self):
        with self.assertRaises(ValueError):
            _docker_options(policy(), "host-path", owner_token="f" * 64)


class EvaluationLifecycleTests(unittest.TestCase):
    def test_default_engine_requires_an_explicit_local_endpoint(self):
        with self.assertRaisesRegex(EvaluationError, "explicit local Docker endpoint"):
            evaluate(b"payload", policy())

    def test_create_accepts_effective_network_tmpfs_and_log_policy(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        responses = [_completed(CONTAINER_ID.encode()), *_container_inspection_responses()]
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=responses) as control:
            self.assertEqual(engine.create(policy(), "guru-eval-" + "c" * 32), CONTAINER_ID)
        self.assertEqual(control.call_args_list[1].args[0][0:3], ["inspect", "--type", "container"])
        self.assertTrue(all(call.args[0][-1] == CONTAINER_ID for call in control.call_args_list[1:]))

    def test_inspection_rejects_effective_network_mismatch_and_cleans_owned_container(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        owner_labels = json.dumps({
            "io.brahmini.guru.evaluator-managed": "v1",
            "io.brahmini.guru.evaluator-owner": "f" * 64,
        }).encode()
        responses = [
            _completed(CONTAINER_ID.encode()),
            _completed(owner_labels), _completed(b'"bridge"'),
            _completed(owner_labels),
            _completed(b""),
        ]
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=responses) as control:
            with self.assertRaisesRegex(EvaluationError, "network policy"):
                engine.create(policy(), "guru-eval-" + "c" * 32)
        self.assertEqual(control.call_args_list[-1].args[0], ["rm", "--force", "--volumes", CONTAINER_ID])

    def test_inspection_rejects_bind_and_volume_sources_and_cleans_owned_container(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        owner_labels = json.dumps({
            "io.brahmini.guru.evaluator-managed": "v1",
            "io.brahmini.guru.evaluator-owner": "f" * 64,
        }).encode()
        for source_config, checked_fields in (
            ({"binds": ["/host:/data"]}, 5),
            ({"config_volumes": {"/host/data": {}}}, 8),
        ):
            with self.subTest(source_config=source_config):
                inspect_responses = _container_inspection_responses(**source_config)
                responses = [
                    _completed(CONTAINER_ID.encode()),
                    *inspect_responses[:checked_fields],
                    _completed(owner_labels), _completed(b""),
                ]
                with patch.object(engine, "_require_evaluation_scope"), \
                     patch.object(engine, "_owner_token", return_value="f" * 64), \
                     patch.object(engine, "_control", side_effect=responses) as control:
                    with self.assertRaisesRegex(EvaluationError, "mount policy"):
                        engine.create(policy(), "guru-eval-" + "c" * 32)
                self.assertEqual(control.call_args_list[-1].args[0], ["rm", "--force", "--volumes", CONTAINER_ID])

    def test_inspection_rejects_bridge_attachment_and_cleans_owned_container(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        owner_labels = json.dumps({
            "io.brahmini.guru.evaluator-managed": "v1",
            "io.brahmini.guru.evaluator-owner": "f" * 64,
        }).encode()
        inspect_responses = _container_inspection_responses(networks={
            "none": {
                "IPAMConfig": None, "Links": None, "Aliases": None, "MacAddress": "",
                "DriverOpts": None, "GwPriority": 0, "NetworkID": "", "EndpointID": "",
                "Gateway": "", "IPAddress": "", "IPPrefixLen": 0, "IPv6Gateway": "",
                "GlobalIPv6Address": "", "GlobalIPv6PrefixLen": 0, "DNSNames": None,
            },
            "bridge": {"NetworkID": "network-id", "IPAddress": "172.17.0.2"},
        })
        responses = [
            _completed(CONTAINER_ID.encode()), *inspect_responses[:3],
            _completed(owner_labels), _completed(b""),
        ]
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=responses) as control:
            with self.assertRaisesRegex(EvaluationError, "external network attachment"):
                engine.create(policy(), "guru-eval-" + "c" * 32)
        self.assertEqual(control.call_args_list[-1].args[0], ["rm", "--force", "--volumes", CONTAINER_ID])

    def test_inspection_rejects_malformed_network_or_mount_data(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        incomplete_host_config = _effective_host_config()
        del incomplete_host_config["PidsLimit"]
        incorrect_tmpfs = _effective_host_config()
        incorrect_tmpfs["Tmpfs"] = {"/tmp": "rw,size=1"}
        extra_tmpfs = _effective_host_config()
        extra_tmpfs["Tmpfs"]["/host"] = "rw"
        malformed_cases = (
            {"network_mode": b"not-json"},
            {"networks": b"not-json"},
            {"networks": b"null"},
            {"networks": {"bridge": {}}},
            {"networks": {"none": {"IPAddress": "172.17.0.2"}}},
            {"mounts": b"not-json"},
            {"mounts": [{"Type": "bind", "Source": "/host", "Destination": "/tmp"}]},
            {"host_mounts": [{"Type": "bind", "Source": "/host", "Target": "/data"}]},
            {"volumes_from": ["other-container"]},
            {"config_volumes": {"/host/data": {}}},
            {"host_config": b"not-json"},
            {"host_config": incomplete_host_config},
            {"host_config": incorrect_tmpfs},
            {"host_config": extra_tmpfs},
            {"config_user": "root"},
        )
        for values in malformed_cases:
            with self.subTest(values=values), \
                 patch.object(engine, "_owner_token", return_value="f" * 64), \
                 patch.object(engine, "_control", side_effect=_container_inspection_responses(**values)):
                with self.assertRaises(EvaluationError):
                    engine._inspect_created_container(CONTAINER_ID, policy())

    def test_inspection_rejects_unsafe_or_mismatched_hostconfig_limits(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        unsafe_values = (
            ("CapAdd", ["SYS_ADMIN"]),
            ("CapDrop", ["NET_RAW"]),
            ("CpuPeriod", 100000),
            ("CpuShares", 1024),
            ("CpuQuota", 200000),
            ("NanoCpus", 2000000000),
            ("Memory", 536870911),
            ("MemorySwap", 1073741824),
            ("PidsLimit", 4096),
            ("CgroupnsMode", "host"),
            ("Privileged", True),
            ("Privileged", 0),
            ("ReadonlyRootfs", False),
            ("SecurityOpt", ["no-new-privileges", "seccomp=unconfined"]),
            ("IpcMode", "host"),
            ("PidMode", "host"),
            ("UTSMode", "host"),
            ("Devices", [{"PathOnHost": "/dev/null"}]),
            ("DeviceRequests", [{"Driver": "nvidia"}]),
        )
        for field, value in unsafe_values:
            with self.subTest(field=field, value=value):
                host_config = _effective_host_config()
                host_config[field] = value
                with patch.object(engine, "_owner_token", return_value="f" * 64), \
                     patch.object(engine, "_control", side_effect=_container_inspection_responses(host_config=host_config)):
                    with self.assertRaisesRegex(EvaluationError, field):
                        engine._inspect_created_container(CONTAINER_ID, policy())

    def test_effective_resource_limits_are_derived_from_policy(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        current_policy = policy(
            cpu_count=1.5, memory_bytes=1024**3, pids_limit=64,
            tmpfs_bytes=128 * 1024**2,
        )
        with patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=_container_inspection_responses(current_policy=current_policy)):
            engine._inspect_created_container(CONTAINER_ID, current_policy)

    def test_empty_device_cgroup_rules_are_allowed_but_nonempty_rules_are_rejected(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        for rules in (None, []):
            with self.subTest(rules=rules):
                host_config = _effective_host_config()
                host_config["DeviceCgroupRules"] = rules
                with patch.object(engine, "_owner_token", return_value="f" * 64), \
                     patch.object(engine, "_control", side_effect=_container_inspection_responses(host_config=host_config)):
                    engine._inspect_created_container(CONTAINER_ID, policy())

        host_config = _effective_host_config()
        host_config["DeviceCgroupRules"] = ["c 1:3 rwm"]
        with patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=_container_inspection_responses(host_config=host_config)):
            with self.assertRaisesRegex(EvaluationError, "DeviceCgroupRules"):
                engine._inspect_created_container(CONTAINER_ID, policy())

    def test_start_does_not_launch_if_effective_network_policy_changes(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=_container_inspection_responses(network_mode="bridge")), \
             patch("guru.code_evaluator.subprocess.Popen") as popen:
            with self.assertRaisesRegex(EvaluationError, "network policy"):
                engine.start(CONTAINER_ID, b"synthetic probe", policy())
        popen.assert_not_called()

    def test_start_does_not_launch_if_container_is_attached_to_bridge(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        networks = _container_inspection_responses()[2].stdout.decode()
        no_network = json.loads(networks)
        no_network["bridge"] = {"NetworkID": "network-id", "IPAddress": "172.17.0.2"}
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=_container_inspection_responses(networks=no_network)), \
             patch("guru.code_evaluator.subprocess.Popen") as popen:
            with self.assertRaisesRegex(EvaluationError, "external network attachment"):
                engine.start(CONTAINER_ID, b"synthetic probe", policy())
        popen.assert_not_called()

    def test_container_log_mismatch_is_rejected_and_owned_container_removed(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        responses = [
            _completed(CONTAINER_ID.encode()),
            *_container_inspection_responses(log_type="json-file"),
            _completed(json.dumps({
                "io.brahmini.guru.evaluator-managed": "v1",
                "io.brahmini.guru.evaluator-owner": "f" * 64,
            }).encode()),
            _completed(b""),
        ]
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=responses) as control:
            with self.assertRaisesRegex(EvaluationError, "logging policy"):
                engine.create(policy(), "guru-eval-" + "c" * 32)
        self.assertEqual(control.call_args_list[-1].args[0], ["rm", "--force", "--volumes", CONTAINER_ID])

    def test_start_rechecks_policy_before_launching_container(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        with patch.object(engine, "_require_evaluation_scope"), \
             patch.object(engine, "_inspect_created_container", side_effect=EvaluationError("logging policy")), \
             patch("guru.code_evaluator.subprocess.Popen") as popen:
            with self.assertRaisesRegex(EvaluationError, "logging policy"):
                engine.start(CONTAINER_ID, b"probe", policy())
        popen.assert_not_called()

    def test_inspection_rejects_wrong_or_compose_owned_labels(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        for labels in (
            {"io.brahmini.guru.evaluator-managed": "v1", "io.brahmini.guru.evaluator-owner": "0" * 64},
            {"io.brahmini.guru.evaluator-managed": "v1", "io.brahmini.guru.evaluator-owner": "f" * 64,
             "com.docker.compose.project": "other"},
        ):
            with self.subTest(labels=labels), \
                 patch.object(engine, "_owner_token", return_value="f" * 64), \
                 patch.object(engine, "_control", return_value=subprocess.CompletedProcess(
                     [], 0, json.dumps(labels).encode(), b"",
                 )) as control:
                with self.assertRaisesRegex(EvaluationError, "ownership"):
                    engine._inspect_created_container(CONTAINER_ID, policy())
                self.assertEqual(control.call_count, 1)

    def test_inspection_rejects_persistent_log_path_and_unreadable_config(self):
        engine = DockerCliEngine(LOCAL_ENDPOINT)
        labels = json.dumps({
            "io.brahmini.guru.evaluator-managed": "v1",
            "io.brahmini.guru.evaluator-owner": "f" * 64,
        }).encode()
        with patch.object(engine, "_owner_token", return_value="f" * 64), \
             patch.object(engine, "_control", side_effect=[
                 *_container_inspection_responses(log_path=b"/var/lib/docker/containers/log.json"),
             ]):
            with self.assertRaisesRegex(EvaluationError, "logging policy"):
                engine._inspect_created_container(CONTAINER_ID, policy())
        with patch.object(engine, "_control", side_effect=EvaluationError("inspect failed")):
            with self.assertRaisesRegex(EvaluationError, "inspect failed"):
                engine._inspect_created_container(CONTAINER_ID, policy())

    def test_public_evaluator_does_not_accept_engine_injection(self):
        fake = FakeEngine()
        with self.assertRaises(TypeError):
            evaluate(b"payload", policy(), fake)
        self.assertEqual(fake.created, [])

    def test_cli_argv_pins_create_start_and_remove_to_local_endpoint(self):
        class FakeProcess:
            def __init__(self, stdout=b""):
                self.stdin = BytesIO()
                self.stdout = BytesIO(stdout)
                self.stderr = BytesIO()
                self.returncode = 0

            def wait(self, timeout=None):
                return self.returncode

            def poll(self):
                return self.returncode

            def kill(self):
                self.returncode = -9

        processes = [FakeProcess((CONTAINER_ID + "\n").encode())]
        for _ in range(2):
            processes.extend(
                FakeProcess(result.stdout + b"\n")
                for result in _container_inspection_responses()
            )
        processes.extend((FakeProcess(), FakeProcess()))
        with tempfile.TemporaryDirectory() as state_directory:
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            with patch.dict(os.environ, {
                "DOCKER_HOST": "tcp://remote.example:2376",
                "DOCKER_CONTEXT": "remote-context",
            }), patch("guru.code_evaluator.subprocess.Popen", side_effect=processes) as popen, \
                    patch.object(engine, "_reap_abandoned_containers"), \
                    patch.object(engine, "_owner_token", return_value="f" * 64):
                with engine.evaluation_scope(policy()):
                    self.assertEqual(engine.create(policy(), "guru-eval-" + "c" * 32), CONTAINER_ID)
                    engine.start(CONTAINER_ID, b"payload", policy())
                    engine.remove(CONTAINER_ID, policy())

            argv = [call.args[0] for call in popen.call_args_list]
            self.assertEqual(len(argv), 27)
            for command in argv:
                self.assertEqual(command[0:3], ["docker", "--host", LOCAL_ENDPOINT])
            self.assertEqual(argv[0][3], "create")
            self.assertEqual(argv[1][3:6], ["inspect", "--type", "container"])
            self.assertEqual(argv[25][3:6], ["start", "--attach", "--interactive"])
            self.assertEqual(argv[26][3:6], ["rm", "--force", "--volumes"])
            for call in popen.call_args_list:
                self.assertNotIn("DOCKER_HOST", call.kwargs["env"])
                self.assertNotIn("DOCKER_CONTEXT", call.kwargs["env"])

    def test_engine_rejects_non_local_endpoint(self):
        for endpoint in ("tcp://remote.example:2376", "ssh://host", "unix://"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                DockerCliEngine(endpoint=endpoint)

    def test_engine_operations_require_managed_lifecycle_scope(self):
        with tempfile.TemporaryDirectory() as state_directory:
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            with patch.object(engine, "_control") as control:
                with self.assertRaisesRegex(EvaluationError, "active evaluator lifecycle"):
                    engine.create(policy(), "guru-eval-" + "c" * 32)
                with self.assertRaisesRegex(EvaluationError, "active evaluator lifecycle"):
                    engine.start(CONTAINER_ID, b"payload", policy())
                with self.assertRaisesRegex(EvaluationError, "active evaluator lifecycle"):
                    engine.remove(CONTAINER_ID, policy())
                control.assert_not_called()

    def test_engine_operations_cannot_be_borrowed_from_another_thread(self):
        with tempfile.TemporaryDirectory() as state_directory:
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            failures = []
            with patch.object(engine, "_reap_abandoned_containers"), patch.object(engine, "_control") as control:
                with engine.evaluation_scope(policy()):
                    def attempt(operation):
                        try:
                            operation()
                        except EvaluationError as exc:
                            failures.append(str(exc))

                    operations = (
                        lambda: engine.create(policy(), "guru-eval-" + "c" * 32),
                        lambda: engine.start(CONTAINER_ID, b"payload", policy()),
                        lambda: engine.remove(CONTAINER_ID, policy()),
                    )
                    threads = [threading.Thread(target=attempt, args=(op,)) for op in operations]
                    for thread in threads:
                        thread.start()
                    for thread in threads:
                        thread.join(timeout=2)
                self.assertEqual(len(failures), 3)
                self.assertTrue(all("active evaluator lifecycle" in failure for failure in failures))
                control.assert_not_called()

    def test_startup_reaper_removes_only_exact_managed_label(self):
        with tempfile.TemporaryDirectory() as state_directory:
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            calls = []

            def control(args, timeout):
                calls.append(args)
                if args[0] == "ps":
                    return Mock(stdout=(
                        b"aaaaaaaaaaaa|guru-eval-" + b"a" * 32 + b"\n" +
                        b"bbbbbbbbbbbb|guru-eval-" + b"b" * 32 + b"\n"
                    ))
                if args[0] == "inspect" and args[-1] == "aaaaaaaaaaaa":
                    return Mock(stdout=json.dumps({
                        "io.brahmini.guru.evaluator-managed": "v1",
                        "io.brahmini.guru.evaluator-owner": "f" * 64,
                    }).encode())
                if args[0] == "inspect" and args[-1] == "bbbbbbbbbbbb":
                    return Mock(stdout=json.dumps({
                        "io.brahmini.guru.evaluator-managed": "v1",
                        "io.brahmini.guru.evaluator-owner": "e" * 64,
                    }).encode())
                if args[0] == "rm":
                    return Mock(stdout=b"")
                raise AssertionError(args)

            with patch.object(engine, "_owner_token", return_value="f" * 64):
                engine._control = control
                with engine.evaluation_scope(policy()):
                    pass

        removals = [args for args in calls if args[0] == "rm"]
        self.assertEqual(removals, [["rm", "--force", "--volumes", "aaaaaaaaaaaa"]])
        self.assertIn("label=io.brahmini.guru.evaluator-managed=v1", calls[0])
        self.assertIn("label=io.brahmini.guru.evaluator-owner=" + "f" * 64, calls[0])

    def test_owner_tokens_separate_private_evaluator_installations(self):
        with tempfile.TemporaryDirectory() as first_state, tempfile.TemporaryDirectory() as second_state:
            first = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=first_state)
            same_install = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=first_state)
            peer_install = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=second_state)
            first_token = first._owner_token()
            self.assertEqual(first_token, same_install._owner_token())
            self.assertNotEqual(first_token, peer_install._owner_token())

    def test_default_recovery_state_is_durable_and_per_installation(self):
        root_a = _default_state_directory("/workspace/checkout-a")
        root_a_again = _default_state_directory("/workspace/checkout-a")
        root_b = _default_state_directory("/workspace/checkout-b")
        self.assertEqual(root_a, root_a_again)
        self.assertNotEqual(root_a, root_b)
        self.assertFalse(root_a.is_relative_to(Path(tempfile.gettempdir())))

    def test_symlink_state_directory_fails_closed(self):
        with tempfile.TemporaryDirectory() as parent:
            target = os.path.join(parent, "private")
            link = os.path.join(parent, "linked")
            os.mkdir(target, 0o700)
            os.symlink(target, link)
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=link)
            with self.assertRaisesRegex(EvaluationError, "state directory"):
                engine._owner_token()

    def test_startup_reaper_malformed_inventory_blocks_evaluation(self):
        with tempfile.TemporaryDirectory() as state_directory:
            engine = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            engine._control = lambda args, timeout: Mock(stdout=b"not-a-container-id|guru-eval-" + b"c" * 32 + b"\n")
            with self.assertRaisesRegex(EvaluationError, "invalid identifier"):
                with engine.evaluation_scope(policy()):
                    self.fail("evaluation must not proceed after unverified inventory")

    def test_lifecycle_lock_serializes_concurrent_engines(self):
        with tempfile.TemporaryDirectory() as state_directory:
            first = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            second = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            second_entered = threading.Event()
            with patch.object(first, "_reap_abandoned_containers"), \
                    patch.object(second, "_reap_abandoned_containers") as reap_second:
                first_scope = first.evaluation_scope(policy(control_timeout_seconds=2))
                first_scope.__enter__()
                thread = threading.Thread(
                    target=lambda: self._enter_scope(second, second_entered), daemon=True,
                )
                thread.start()
                time.sleep(0.15)
                self.assertFalse(second_entered.is_set())
                reap_second.assert_not_called()
                first_scope.__exit__(None, None, None)
                thread.join(timeout=2)
                self.assertTrue(second_entered.is_set())
                reap_second.assert_called_once()

    def test_process_crash_releases_lock_for_next_startup_reaper(self):
        with tempfile.TemporaryDirectory() as state_directory:
            ready = os.path.join(state_directory, "child-ready")
            module_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            child_code = (
                "import sys,time; from pathlib import Path; "
                "from guru.code_evaluator import DockerCliEngine,EvaluationPolicy; "
                "p=EvaluationPolicy(image='registry.example.invalid/guru-runner@sha256:'+'a'*64,command=('/opt/runner',)); "
                "e=DockerCliEngine('unix:///var/run/docker.sock',state_directory=sys.argv[1]); "
                "e._reap_abandoned_containers=lambda policy: None; "
                "scope=e.evaluation_scope(p); scope.__enter__(); "
                "Path(sys.argv[2]).write_text('locked'); time.sleep(60)"
            )
            child_env = os.environ.copy()
            child_env["PYTHONPATH"] = os.pathsep.join(filter(None, [module_root, child_env.get("PYTHONPATH", "")]))
            child = subprocess.Popen(
                [sys.executable, "-c", child_code, state_directory, ready],
                env=child_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            deadline = time.monotonic() + 5
            while not os.path.exists(ready) and time.monotonic() < deadline:
                if child.poll() is not None:
                    self.fail(child.stderr.read().decode("utf-8", "replace"))
                time.sleep(0.02)
            self.assertTrue(os.path.exists(ready), "child did not acquire evaluator lock")
            child.kill()
            child.wait(timeout=2)

            next_start = DockerCliEngine(endpoint=LOCAL_ENDPOINT, state_directory=state_directory)
            with patch.object(next_start, "_reap_abandoned_containers") as reaper:
                with next_start.evaluation_scope(policy()):
                    pass
            reaper.assert_called_once()

    @staticmethod
    def _enter_scope(engine, entered):
        with engine.evaluation_scope(policy(control_timeout_seconds=2)):
            entered.set()

    def test_happy_path_records_hash_and_cleanup(self):
        fake = FakeEngine(EngineResult(7, b"bounded stdout", b"diagnostic"))
        evidence = _evaluate_with_engine(b"opaque request", policy(), fake)
        self.assertEqual(evidence.exit_code, 7)
        self.assertEqual(len(evidence.input_sha256), 64)
        self.assertTrue(evidence.container_removed)
        self.assertEqual(fake.removed, [CONTAINER_ID])
        self.assertEqual(fake.started[0][1], b"opaque request")

    def test_removes_container_after_start_failure(self):
        fake = FakeEngine(fail_start=True)
        with self.assertRaisesRegex(RuntimeError, "mock start failure"):
            _evaluate_with_engine(b"payload", policy(), fake)
        self.assertEqual(fake.removed, [CONTAINER_ID])

    def test_cleanup_failure_fails_closed(self):
        fake = FakeEngine(fail_remove=True)
        with self.assertRaisesRegex(RuntimeError, "mock cleanup failure"):
            _evaluate_with_engine(b"payload", policy(), fake)

    def test_rejects_oversized_input_before_creating_container(self):
        fake = FakeEngine()
        with self.assertRaisesRegex(EvaluationError, "input exceeds"):
            _evaluate_with_engine(b"12345", policy(input_limit_bytes=4), fake)
        self.assertEqual(fake.created, [])

    def test_bounds_combined_evidence_output(self):
        fake = FakeEngine(EngineResult(0, b"a" * 1200, b"b" * 100, output_limited=True))
        evidence = _evaluate_with_engine(b"x", policy(output_limit_bytes=1024), fake)
        self.assertLessEqual(len(evidence.stdout) + len(evidence.stderr), 1024)
        self.assertTrue(evidence.output_limited)
        self.assertTrue(evidence.stdout_truncated)


if __name__ == "__main__":
    unittest.main()
