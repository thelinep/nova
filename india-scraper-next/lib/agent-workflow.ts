import { completeAsAgent } from './agent-router';
import type { ChatMessage } from './providers/types';

export interface WorkflowContext {
  [key: string]: unknown;
}

export interface WorkflowStep {
  id: string;
  role: string;
  // Build this step's user-turn messages from whatever earlier steps put
  // into the context. The workflow always prepends nothing else -- the
  // role's own systemPrompt/skills (lib/agent-router.ts) still apply.
  buildMessages(context: WorkflowContext): ChatMessage[];
  // Key this step's result.content is stored under in the returned context.
  captureAs: string;
  // Skip this step (and leave captureAs unset) when false.
  shouldRun?(context: WorkflowContext): boolean;
}

export interface Workflow {
  id: string;
  label: string;
  steps: WorkflowStep[];
}

export interface WorkflowStepRecord {
  stepId: string;
  ran: boolean;
  role?: string;
  provider?: string;
  error?: string;
}

export interface WorkflowRunResult {
  context: WorkflowContext;
  steps: WorkflowStepRecord[];
}

export async function runWorkflow(workflow: Workflow, initialContext: WorkflowContext = {}): Promise<WorkflowRunResult> {
  const context: WorkflowContext = { ...initialContext };
  const steps: WorkflowStepRecord[] = [];

  for (const step of workflow.steps) {
    if (step.shouldRun && !step.shouldRun(context)) {
      steps.push({ stepId: step.id, ran: false });
      continue;
    }
    try {
      const messages = step.buildMessages(context);
      const result = await completeAsAgent(step.role, messages);
      context[step.captureAs] = result.content;
      steps.push({ stepId: step.id, ran: true, role: step.role, provider: result.provider });
    } catch (error) {
      steps.push({
        stepId: step.id,
        ran: true,
        role: step.role,
        error: error instanceof Error ? error.message : String(error),
      });
      // A step's failure stops the pipeline -- later steps likely depend on
      // this one's output, and silently continuing with a missing
      // captureAs key would just push the failure further downstream.
      break;
    }
  }

  return { context, steps };
}

// One concrete, grounded example: turn this project's own district-collection
// status figures into a short narrative report, the same kind of thing the
// "status matrix" work earlier in this project did by hand.
export const WORKFLOWS: Record<string, Workflow> = {
  'district-collection-health-report': {
    id: 'district-collection-health-report',
    label: 'District collection health report',
    steps: [
      {
        id: 'triage-findings',
        role: 'bulk-classification',
        captureAs: 'findings',
        buildMessages: (context) => [
          {
            role: 'user',
            content:
              'Given this raw collection status JSON, list the 3-5 facts a status report must lead with ' +
              '(plain facts only, no recommendations):\n\n' + JSON.stringify(context.statusJson ?? {}, null, 2),
          },
        ],
      },
      {
        id: 'draft-report',
        role: 'status-report-writing',
        captureAs: 'report',
        shouldRun: (context) => typeof context.findings === 'string' && context.findings.trim().length > 0,
        buildMessages: (context) => [
          { role: 'user', content: `Write the status report from these findings:\n\n${context.findings}` },
        ],
      },
    ],
  },
};
