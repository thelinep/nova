import type { Skill } from './types';

// Real, product-specific skills for this repo's agent roles to load.
// Deliberately small and editable -- expect to rewrite `systemPrompt` on
// each of these with real examples once an agent role is actually run
// against real data; these are a sketch starting point, not tuned prompts.
export const SKILLS: Record<string, Skill> = {
  'district-domain-knowledge': {
    id: 'district-domain-knowledge',
    description: `Explains this project's district/state collection data shape and vocabulary.`,
    systemPrompt: `Domain context: this product collects event-planner businesses across 784 Indian districts in 36 states. Each district has a status: "pending" (not yet attempted), "limited_view" (collected but Google Maps only showed a capped result list), or "visible_list_exhausted" (every visible result was collected). "matchedPlanners" counts businesses classified as event planners out of all "uniqueBusinesses" found. A state is "fully attempted" once every district in it has moved off "pending".`,
  },

  'event-planner-classification-rules': {
    id: 'event-planner-classification-rules',
    description: `Heuristics for labeling a scraped business as an event planner or not.`,
    systemPrompt: `When classifying a business name/category/description as an event planner: treat explicit category matches ("event planner", "event management", "wedding planner", "banquet/event venue with planning services") as clear positives; treat adjacent-but-distinct categories (pure photographers, pure caterers, pure decorators with no planning/coordination language, wedding halls with no planning service) as negatives unless the description explicitly offers end-to-end event planning or coordination. When genuinely ambiguous, say so rather than guessing -- this is a starting heuristic to refine against real labeled examples, not a final rule set.`,
  },

  'status-report-style': {
    id: 'status-report-style',
    description: `House style for narrative status reports on this project.`,
    systemPrompt: `Write status reports numbers-first: state the current figures plainly before any interpretation. Separate plain facts from flags/risks -- never bury a risk inside a sentence of good news. No bullet-point padding; write in short, direct prose paragraphs. Never claim a run, fix, or deployment happened unless the data given to you actually shows it.`,
  },

  'maataa-roadmap-context': {
    id: 'maataa-roadmap-context',
    description: `This project's 8-milestone delivery roadmap, for triage/prioritization tasks.`,
    systemPrompt: `This product's roadmap has 8 milestones: location catalogue, district collection engine, search designer, live planner map, Maataa local conversations, helpers and scheduler, all-district coverage, and packaged local release. The last two ("all-district coverage", "packaged local release") depend on the district collection engine actually finishing -- never recommend prioritizing the release milestone while collection is still incomplete.`,
  },

  'repo-read-only-tools': {
    id: 'repo-read-only-tools',
    description: `Grants read-only repo filesystem tools via the "filesystem" MCP server.`,
    systemPrompt: `You may read files in this repository with the provided tools to check your answer against real code before responding. You cannot write, edit, or delete anything -- if a task needs that, say so instead of attempting it.`,
    tools: ['read_file', 'list_directory', 'search_files'],
  },
};

export function getSkill(id: string): Skill | undefined {
  return SKILLS[id];
}

export function loadSkillPrompts(ids: string[] = []): string {
  return ids
    .map((id) => SKILLS[id]?.systemPrompt)
    .filter((prompt): prompt is string => Boolean(prompt))
    .join('\n\n');
}

// Which tool names the given skills collectively allow. An AgentRole with
// toolServers set but no skill naming a tool gets every tool that server
// exposes; once any loaded skill declares `tools`, only those names pass.
export function allowedToolNames(ids: string[] = []): string[] | null {
  const declared = ids.map((id) => SKILLS[id]?.tools).filter((tools): tools is string[] => Boolean(tools));
  if (declared.length === 0) return null;
  return declared.flat();
}
