# Maataa Everywhere — Architecture (formerly NOVA Everywhere)

*Status: direction agreed, October 2026. Naming updated: NOVA is absorbed into the MAATAA brand (section 0); NOVA remains the engineering codename. Owner: Hemant. Phase 1 (Desktop contract and device identity) is in progress in `nova-console` on the `codex/absorb-tlps-locations` branch.*

## 0. Naming

NOVA is absorbed into the existing **Maataa Ecosystem** as the MAATAA governed-intelligence product line. It does not redefine the ecosystem.

```
MAATAA ECOSYSTEM (umbrella)
├── MAATAA            Governed intelligence layer  ("Intelligence for a Higher Good")
│   ├── Maataa Workstation · Maataa Mobile · Maataa Web · Maataa Edge · Maataa Robotics
│   ├── Maataa Control (fleet, identity, policy, audit above all surfaces)
│   └── Maataa Runtime (execution contracts + evidence core; codename NOVA)
├── MAATAA UI         Interface / component system
├── Maataa OS Runtime · Brahmini Chain · Communication Engine · Replay + Proof System
└── Saptadhaatu · Lipi System · TLP · Vaigyaaniq Radio · Ayodhya AI Studio · ALLB Ecosystem
```

| Layer | Name |
| --- | --- |
| Public brand | MAATAA |
| First product | Maataa Workstation |
| Engineering codename | NOVA |
| Repository | thelinep/nova (unchanged for now) |
| Internal identifiers | `NOVA_*` settings, `lib/` names (unchanged for now) |
| App bundle / data folder | `com.brahmini.nova-runtime` (unchanged until a migration) |
| Local models | `guru-maataa` (renamed from `maataa:latest`, October 2026); further models follow the same pattern. The platform name is never a model name. |

Sequence: (1) public and product rename in what people see; (2) model namespace; (3) a separate, explicit technical migration (bundle ID, data folder, env vars, repository) that moves sessions, databases, device identity, evidence, models, characters, knowledge and secrets intact.

Open items before the public rename: trademark search for MAATAA (India, US, EU; classes 9 and 42); domain set including common misspellings; check with Spanish and Portuguese speakers that it does not read as "mata" (kills); decide whether Maataa Runtime **is** Maataa OS Runtime or a part of it, and connect contract evidence to the existing Replay + Proof System and Brahmini Chain rather than building parallel ones.

## 1. Thesis

MAATAA is **one intelligence and governance platform with five execution surfaces**, not five products.

> MAATAA is the governed intelligence layer between humans, AI models, computers, connected devices and physical machines.

**Desktop does the heavy work. Mobile controls it. Web makes it reachable from anywhere. IoT gives it senses. Robots give it physical agency.**

```
                         MAATAA
                            │
          ┌─────────────────┼─────────────────┐
      INTELLIGENCE      GOVERNANCE         EVIDENCE
   Models / Context     Policy / RBAC     Audit / Trace
   Memory / RAG        Approval / Budget  Verification
   Agents / Planning   Permissions        Recovery
          └─────────────────┼─────────────────┘
                 MAATAA RUNTIME
       ┌──────────┬─────────┼─────────┬──────────┐
      WEB       MOBILE    DESKTOP     IoT      ROBOTS
```

The local-first thesis stays: for an individual, everything above runs on their own Workstation. Shared infrastructure appears only when a team or an enterprise needs it (decision D1).

## 2. The five surfaces

| Dimension | Web | Mobile | Desktop | IoT / Edge | Robots |
| --- | --- | --- | --- | --- | --- |
| Primary role | Access | Companion and control | Main workstation | Sense and trigger | Physical action |
| Human interaction | High | Very high | Very high | Low | Medium |
| Heavy inference | Remote | Light or remote | Excellent | Limited | Edge or workstation |
| Local models | Limited | Small models | Full models | Tiny, specialised | Vision and control models |
| Files | Browser-mediated | Device files | Full workspace | Device data | Mission data |
| Repositories | Review | Review and approve | Full development | — | Robot software |
| Agents | Monitor and request | Monitor and approve | Create and execute | Trigger | Execute missions |
| Browser agent | Via workstation | Delegate | Full Playwright | — | Usually none |
| Camera | Browser permission | Excellent | Webcam | Sensors | Vision |
| Voice | Good | Excellent | Excellent | Commands | Commands |
| Approvals | Good | Best surface | Full | Usually none | Required for risk |
| Tool execution | Via workstation | Limited | Full | Device commands | Physical commands |
| Automation | Configure | Monitor | Author and run | Trigger | Missions |
| Evidence | Inspect | Inspect | Generate and manage | Generate | Critical |
| Kill switch | Yes | Excellent | Master | Yes | Mandatory |
| Offline | Limited | Good | Excellent | Essential | Essential |
| Safety consequence | Low–medium | Medium | Medium | Medium–high | Highest |

### 2.1 Maataa Workstation (Desktop): intelligence workstation

The reference implementation and main compute node, and **the first commercially certified product**: *private AI that does real work on your machine under governed authority.*

It owns sessions, knowledge, repository intelligence, Workbench, agents, the Agent Browser, code execution, Git, ComfyUI, voice, converters, evaluations, automations, policy, approvals, evidence and recovery. It also owns the heavy processes: Ollama, Node and Rust services, Playwright and Chrome, ComfyUI, FFmpeg, Pandoc, ImageMagick, Graphviz, GDAL, Assimp, Blender, compilers, test runners and containers.

### 2.2 Maataa Mobile: human authority console

Mobile does not compete with desktop compute. Its job is to **observe → communicate → capture → approve → intervene**.

- **Ask:** chat, voice, camera
- **Capture:** photo, OCR, document, audio, video
- **Control:** agents, jobs, automations, workstations
- **Govern:** approval, diff review, permission, budget, kill
- **Verify:** evidence, tests, screenshots, activity

The signature interaction:

```
Workstation agent needs permission
  → phone notification → Face ID / fingerprint
  → view plan, diff and risk → APPROVE
  → signed authorization (bound to the plan hash)
  → Workstation executes → verification → evidence back to the phone
```

Tauri 2's capability model separates desktop and Android/iOS permissions, and native Kotlin/Swift plugins provide biometrics and barcode scanning.

### 2.3 Maataa Web: universal access plane

Zero-install access: *securely reach your intelligence and governed workloads from any browser.* Web offers chat, knowledge, agents, workspaces, approvals, evidence, evaluations, administration and fleet monitoring.

It never pretends that browser JavaScript has desktop authority. "Run tests on this repository" from Web becomes an authenticated request → policy → Workstation runs `npm test` → evidence returns to Web.

### 2.4 Maataa Edge (IoT): sensing and edge plane

IoT nodes run a small **Maataa Edge Agent**, not the full UI. The pipeline is:

sensors → normalise → local rules → edge intelligence → event → NOVA policy → action or escalation

- **Sensors:** temperature, humidity, motion, camera, microphone, GPS, IMU, energy, air quality, proximity and equipment telemetry.
- **Protocols:** MQTT, OPC-UA, Modbus, CAN, BLE, Zigbee/Thread, Matter, serial, GPIO and WebSockets.
- **Authority:** each device gets the minimum authority it needs.

### 2.5 Maataa Robotics: physical intelligence plane

**An LLM never becomes the real-time safety controller.** NOVA sits above the deterministic control layer:

```
NOVA goal / mission → agent planning → policy + safety → human approval
  → mission manager → ROS 2 → motion planning → robot controller
  → HARDWARE SAFETY CONTROLLER → motors / arms / grippers
```

NOVA commands intent ("Inspect storage aisle 7"), never actuation ("set left motor PWM to 83%"). ROS 2 and ros2_control are the interoperability boundary, covering Universal Robots, Franka, Fanuc, Kinova, Clearpath, ROBOTIS, xArm and others, and buses such as EtherCAT, CANopen and Modbus.

## 3. One execution contract

Every surface uses the same governed contract. Only the execution adapter changes.

```
ACTOR → DEVICE → INTENT → CONTEXT → CAPABILITY → PLAN → POLICY → RISK
  → BUDGET → APPROVAL → EXECUTION → OBSERVATION → VERIFICATION → EVIDENCE
```

| Adapter | Web | Mobile | Desktop | IoT | Robot |
| --- | --- | --- | --- | --- | --- |
| Executes through | HTTP/API, remote | Native camera, voice, sensors | Process, shell, files, browser | MQTT, OPC-UA, Modbus, GPIO | ROS 2 actions, services, topics |

### 3.1 Identity: Human + Device + Agent

The governance model grows from *user → workspace → agent* to:

**Organization → Workspace → Human → Device → Agent → Capability → Resource**

Policy decides whether the exact chain is authorised. Two examples:

- *Hemant → Pixel phone → Engineering Agent → NOVA MacBook → Customer-X repository → WRITE*
- *Operator → Maataa Mobile → Inspection Agent → Robot-17 → camera → Warehouse Zone B*

### 3.2 Device classes

| Class | Examples | Authority |
| --- | --- | --- |
| INTERFACE | Web browser | Request |
| COMPANION | Phone, tablet | Request + approve |
| WORKSTATION | Mac, PC, Linux | Compute + execute (+ request, approve) |
| EDGE | Pi, Jetson, MCU gateway | Sense + constrained act |
| ROBOT | AMR, arm, drone | Physical action |

### 3.3 Capabilities

`chat`, `camera.capture`, `microphone.capture`, `file.read`, `file.write`, `repo.read`, `repo.write`, `browser.read`, `browser.act`, `process.execute`, `iot.read`, `iot.control`, `robot.observe`, `robot.navigate`, `robot.manipulate`.

**A capability is not an authorization.** A device declares what it can do. Policy plus approval decide what it may do, one contract at a time.

## 4. Control plane and product family

```
MAATAA CONTROL PLANE: Identity • Devices • Agents • Models • Policy • Budget
                    Approval • Jobs • Evidence • Audit • Fleet • Recovery
        │  MAATAA SECURE FABRIC
  WEB · MOBILE · DESKTOP · EDGE · ROBOT  →  EVIDENCE  →  MAATAA AUDIT GRAPH
```

- **Maataa Workstation:** individual professional intelligence and execution.
- **Maataa Mobile:** companion, capture, approvals and remote control.
- **Maataa Web:** browser access, collaboration and administration.
- **Maataa Edge:** IoT gateways, sensing, local intelligence and controlled device actions.
- **Maataa Robotics:** governed mission intelligence above ROS and robot control.
- **Maataa Control** (above all five): enterprise identity, fleet, policies, agents, models, approvals, budgets, evidence, audit and emergency controls.

## 5. Decisions

**D1. The Workstation is the control plane for individuals.** Maataa Control as a separate service exists only in the Team and Enterprise tiers. No cloud dependency before Desktop earns revenue.

**D2. Mobile trust is a protocol, not a UI.** Workstations sit behind NAT, so Mobile requires:
- pairing by QR code that exchanges device public keys;
- an end-to-end-encrypted relay that cannot read what it carries;
- approvals that are signed by the approving device's key, bound to the hash of the exact plan or diff, single-use (nonce) and time-limited.

If the plan changes after approval, the approval is void.

**D3. Mobile is a client of the Workstation.** Maataa Runtime (NOVA core) is Node, which does not run on Android or iOS. On-device models on the phone are a separate, later effort. The first Mobile release may be a paired web page served through the relay, before a native Tauri mobile app.

**D4. Web never opens the Workstation's port.** The server keeps accepting only loopback connections with Origin checks. Web reaches a Workstation only through the same paired relay.

**D5. Risk tiers, not approve-everything.** Only actions above a risk threshold reach the phone. Low-risk actions go straight to evidence. This prevents approval fatigue and rubber-stamping.

**D6. Evidence has integrity.** Every device signs its evidence. Contracts are hash-chained, so a removed or reordered record is detected. The audit graph is verifiable, not just a log.

**D7. Physical surfaces stay at the mission layer.** Maataa Robotics talks to ROS 2 actions and services, never to actuators, and never claims to be a safety function. Hardware safety controllers and standards (ISO 10218, IEC 61508, IEC 62443) remain authoritative. Product claims must match this.

**D8. Sequence: Desktop → Mobile → Web/Team → Edge → Robotics.** Edge and Robotics come only after the contract and evidence model has been proven on Desktop, because physical authority raises the safety bar.

## 6. Roadmap

| Phase | Deliverable | Proves |
| --- | --- | --- |
| **1. Desktop contract** *(in progress)* | Execution contract record for every governed action. Workstation device identity (Ed25519). Plan-hash-bound, single-use approvals. Hash-chained, device-signed evidence with a verify endpoint. | The contract and evidence model |
| 2. Mobile pairing | QR pairing, device registry (companion class), relay, signed remote approvals, push notifications, kill switch from the phone. | Remote human authority |
| 3. Mobile app | Tauri 2 Android/iOS: biometrics, capture (photo, OCR, audio), diff and plan review, evidence viewer. | Companion surface |
| 4. Web / Team | Paired web client through the relay, organisations, RBAC, shared workstations, Maataa Control for teams. | Multi-user governance |
| 5. Edge | Maataa Edge Agent (MQTT first), event → policy → action, constrained device capabilities. | Sensing under governance |
| 6. Robotics | ROS 2 mission adapter (actions and services), mission approval, simulation-first evidence. | Physical intent under governance |

## 7. What exists today (Workstation)

These already exist in `nova-console`:

- **Policy:** default-deny policy engine with hashed decisions (`lib/policy.js`).
- **Kill switch:** halt and resume with a resume passphrase (`lib/killswitch.js`, `lib/resume-passphrase.js`).
- **Approvals:** per-action approvals for computer use, with risk levels (`lib/computer.js`).
- **Workspace changes:** hash-bound, single-use approvals with rollback (`lib/workspace-changes.js`).
- **Evidence:** an encrypted, hash-chained audit log (`lib/desktop-security.js`); Workbench oversight; budgets.
- **Agent Browser:** allowlist and egress controls (`lib/browser-service.js`).

Phase 1 unifies these under one contract record and adds device identity.
