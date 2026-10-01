---
id: neuron-factory
title: Neuron Factory
section: Capabilities
order: 33.5
summary: Train very small, single-purpose models on this computer — a tiny neural network from examples, or a simulated quantum circuit — then check their quality and approve them.
keywords: neuron factory tensor network qubit circuit simulation train blueprint micro macro approve evaluate artifact final loss background job small model purpose
views: neurons
---
**Neuron Factory** (Capabilities) trains very small models that do one job each, entirely on this computer. It does not train or change your Ollama models.

@screen media/neuron-factory.jpg "Neuron Factory: describe the purpose, pick a kind and scale, and give the training data."

## Two kinds

| Kind | What it is | What you give it |
| --- | --- | --- |
| Tensor network | A tiny neural network (one hidden layer) trained on your examples | Input size, output size, and pairs of input and target numbers |
| Qubit circuit simulation | A simulated quantum circuit trained to produce a pattern of outcomes | The number of qubits and layers, and the target probability of each outcome |

> **Important** Qubit circuits are simulations on your Mac's processor. No real quantum hardware is used, and each result says so.

## Make one

1. Give it a **Name** and a **Purpose** (8 to 500 characters, saying what it is for).
2. Choose the **Artifact kind** and the **Scale**.
3. Edit the **Training specification**. Changing the kind fills in a working example (for a tensor network, it learns "both inputs on").
4. Press **Create blueprint**, then **Queue training** on its card.

Training runs in the background, so you can keep using NOVA. The card shows the job's progress, then the result, including its **final loss** (how far the outputs are from the targets: lower is better).

## Scale

| Scale | Limits | Approval |
| --- | --- | --- |
| Micro | up to 256 examples, 300 training rounds, 16 values wide, 4 qubits | Not needed |
| Macro | up to 2,048 examples, 1,200 rounds, 64 values wide, 8 qubits | **Approve macro job** before it can train |

## Check and approve the result

1. **Evaluate quality** checks the result against a bar: final loss at most 0.08 for a tensor network, or 0.05 for a qubit circuit.
2. If it passes, **Approve artifact** marks it ready to use. Approved results cannot be changed; train a new one instead.

A result that fails the check stays unapproved, and you can change the specification and train again.

## Good to know

- If NOVA restarts while a job is training, the job is marked **interrupted** and the blueprint can be queued again.
- While NOVA is halted with the kill switch in [Workbench](help:workbench), new training is refused.
- Blueprints, results and evaluations can only be changed by NOVA itself, not through the general data interface.
