// A Skill is a reusable chunk of agent behavior: a prompt fragment plus,
// optionally, the names of tools it's meant to be used with. An AgentRole
// (lib/agent-router.ts) loads zero or more skills; their prompts concatenate
// onto the role's own systemPrompt, and their tool names narrow which of the
// role's MCP tools are actually offered to the model for that turn.
export interface Skill {
  id: string;
  description: string;
  systemPrompt: string;
  // Tool names this skill expects to use. Leave empty/omitted for a
  // knowledge-only skill that never calls a tool.
  tools?: string[];
}
