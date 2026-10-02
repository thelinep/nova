---
id: collector-graph
title: Collector, Capability Graph and Provider Browser
section: Capabilities
order: 34
summary: See the Brahmini collector's runs inside Maataa, map how everything connects, and open hosted AI providers in a separate window.
keywords: collector brahmini capability graph provider browser chatgpt claude gemini perplexity separate window
views: collector,graph,browser
---
## Collector

**Collector** shows plans, runs and evidence from the separate Brahmini Knowledge Collector app (a Next.js app in the same repository) and venue observations it recorded. It is read from that app's data; running the collector itself happens there.

@screen media/collector.jpg "Collector: runs and evidence from the Brahmini collector."

## Capability Graph

**Capability Graph** draws which workflows use which agents, and which skills and tool servers each agent may use. Use it to check what an agent can reach before you run it.

@screen media/graph.jpg "Capability Graph: workflows, agents, skills and tool servers."

## Provider Browser

**Provider Browser** opens Claude, ChatGPT, Gemini, Perplexity or another HTTPS site in a separate NOVA-owned window.

@screen media/browser.jpg "Provider Browser opens provider sites in a separate window."

- Pick a provider card or type an HTTPS address. Local development pages at `http://localhost` or `http://127.0.0.1` also work.
- Sign in directly on the provider's page. Maataa does not see or store that password, session or key.
- The provider page stays apart from your Maataa sessions, knowledge, tools, agents and automations. Copy material across deliberately when you want to.
