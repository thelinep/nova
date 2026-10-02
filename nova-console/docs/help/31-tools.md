---
id: tools-approvals
title: Tools and approvals (MCP Registry)
section: Capabilities
order: 31
summary: The tool servers models can call — files, git and a web browser — and how Maataa asks before anything happens.
keywords: mcp registry tool servers filesystem git browser automation playwright approval policy ask allow connect disconnect permissions
views: mcp
---
Tool servers give models real abilities: reading files, checking git, browsing the web. Maataa starts each server as a local child process and talks to it over the MCP protocol.

@screen media/mcp.jpg "The MCP Registry: servers, their tools and approval policy."

## The built-in servers

| Server | Tools | Notes |
| --- | --- | --- |
| Local Filesystem | list and read files in approved folders | Only paths its policy allows |
| Git | status, log, diffs | Read-only |
| Browser Automation | open a page, read its text, list links, click, type, screenshot | Headless Chromium; connects only while network access is on; http and https only |

## Before you call a tool

1. Check the server shows **Connected**.
2. Read the tool's description and inputs.
3. Check the server's approval policy: **ask** (a person approves each call) or **allow**.
4. Approve only the request you mean to allow.

Pending approvals appear in the MCP Registry and wherever the call came from. Rejecting one stops that call. The same rules apply when an agent, skill or workflow makes the call; nothing bypasses them.

## Good habits

- Disconnect a server you no longer need. Servers do not survive a Maataa restart and must reconnect.
- Keep **ask** on for anything that changes files or reaches the web.
- If Browser Automation reports that Chromium could not start, run `npx playwright install chromium` in `nova-console`.
