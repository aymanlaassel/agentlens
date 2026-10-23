import type { Chat, ChatMessage, RoleDefinition, WorkflowRun, WorkflowTemplate } from '../shared/types';
import { PERMISSION_LABEL } from './roles';

export const DIRECTIVE_FENCE = 'agentlens';
const MAX_TITLE = 48;
const MAX_HANDBACK_OUTPUT = 6000;

/** What the conductor may ask AgentLens to do. */
export interface WorkflowDirective {
  action: 'run-workflow';
  goal: string;
  templateId?: string;
  roleIds?: string[];
  name?: string;
}

/** System prompt appended to the conductor session. Roles and templates are listed so it can delegate. */
export function buildConductorPrompt(roles: RoleDefinition[], templates: WorkflowTemplate[]): string {
  const roleLines = roles.map((r) => `- ${r.id} (${PERMISSION_LABEL[r.permission]}): ${r.description || r.name}`);
  const templateLines = templates.map((t) => `- ${t.id}: ${t.name} — ${t.roleIds.join(' → ')}`);
  return [
    'You are the Conductor inside AgentLens, a desktop app the user opens to work on the project in the current directory.',
    'You talk with the user, inspect the project with your read-only tools, and delegate work that changes files or runs commands to a team of agents.',
    'You never edit files or run commands yourself.',
    '',
    'Available roles:',
    ...roleLines,
    '',
    'Available workflow templates (roles run in order, each receives the previous output):',
    ...templateLines,
    '',
    'To delegate, end your reply with exactly one fenced block of this form and nothing after it:',
    '```' + DIRECTIVE_FENCE,
    '{"action":"run-workflow","templateId":"plan-build-review","goal":"<complete, self-contained goal for the agents>"}',
    '```',
    'Use "roleIds":["planner","coder"] instead of "templateId" for a custom sequence. Write the goal so an agent with no access to this conversation can act on it.',
    'Delegate only when the user asks for something to be done. For questions, explanations, or small lookups, answer directly.',
    'Use the pr-review-merge template only when the user explicitly asked to merge; otherwise use pr-review. Always include the PR number or URL in the goal, and state in the goal whether merging is authorized.',
    'When a workflow finishes, AgentLens sends you its result; summarise it for the user plainly, call out failures, and suggest the next step.',
    'Keep replies short. Do not repeat the directive JSON in prose.',
  ].join('\n');
}

/** Split a conductor reply into prose and the directives it carried. Malformed blocks are left in the prose. */
export function extractDirectives(text: string): { text: string; directives: WorkflowDirective[]; problems: string[] } {
  const directives: WorkflowDirective[] = [];
  const problems: string[] = [];
  const pattern = new RegExp('```' + DIRECTIVE_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g');
  const cleaned = text.replace(pattern, (whole, body: string) => {
    try {
      const parsed = JSON.parse(body.trim()) as unknown;
      const directive = toDirective(parsed);
      if (typeof directive === 'string') {
        problems.push(directive);
        return whole;
      }
      directives.push(directive);
      return '';
    } catch (error) {
      problems.push(`directive is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return whole;
    }
  });
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), directives, problems };
}

function toDirective(raw: unknown): WorkflowDirective | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'directive must be a JSON object';
  const r = raw as Record<string, unknown>;
  if (r.action !== 'run-workflow') return `unknown action "${String(r.action)}"`;
  if (typeof r.goal !== 'string' || !r.goal.trim()) return 'directive needs a goal';
  const roleIds = Array.isArray(r.roleIds) ? r.roleIds.filter((v): v is string => typeof v === 'string' && !!v) : [];
  const templateId = typeof r.templateId === 'string' && r.templateId ? r.templateId : undefined;
  if (!templateId && !roleIds.length) return 'directive needs a templateId or roleIds';
  return {
    action: 'run-workflow',
    goal: r.goal.trim(),
    ...(templateId ? { templateId } : {}),
    ...(roleIds.length ? { roleIds } : {}),
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim() } : {}),
  };
}

export function chatTitle(firstMessage: string): string {
  const line = firstMessage.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!line) return 'New chat';
  return line.length > MAX_TITLE ? line.slice(0, MAX_TITLE - 1).trimEnd() + '…' : line;
}

export function createChat(seed: { id: string; cwd: string; sessionId: string; title?: string; now: number }): Chat {
  return {
    id: seed.id,
    title: seed.title?.trim() || 'New chat',
    cwd: seed.cwd,
    sessionId: seed.sessionId,
    sessionStarted: false,
    status: 'idle',
    messages: [],
    createdAt: seed.now,
    updatedAt: seed.now,
  };
}

export function appendMessage(chat: Chat, message: ChatMessage): Chat {
  const title = chat.messages.length === 0 && message.kind === 'user' && chat.title === 'New chat' ? chatTitle(message.text) : chat.title;
  return { ...chat, title, messages: [...chat.messages, message], updatedAt: message.at };
}

export function updateMessage(chat: Chat, id: string, patch: Partial<ChatMessage>, now: number): Chat {
  const index = chat.messages.findIndex((m) => m.id === id);
  if (index === -1) return chat;
  const messages = chat.messages.slice();
  messages[index] = { ...(messages[index] as ChatMessage), ...patch };
  return { ...chat, messages, updatedAt: now };
}

/** Message AgentLens sends to the conductor on the user's behalf when a delegated workflow ends. */
export function workflowHandback(workflow: WorkflowRun, roles: RoleDefinition[]): string {
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const lines = [`Workflow "${workflow.name}" ${workflow.status}.`, '', 'Steps:'];
  for (const step of workflow.steps) {
    const extra = step.error ? ` — ${step.error.split('\n')[0]}` : '';
    lines.push(`- ${roleName(step.roleId)}: ${step.status}${extra}`);
  }
  const last = [...workflow.steps].reverse().find((s) => s.output);
  if (last) {
    const output = (last.output as string).trim();
    lines.push('', `Final output (${roleName(last.roleId)}):`, '', output.length > MAX_HANDBACK_OUTPUT ? output.slice(0, MAX_HANDBACK_OUTPUT) + '\n…(truncated)' : output);
  }
  if (workflow.error) lines.push('', `Error: ${workflow.error}`);
  lines.push('', 'Summarise this for the user and suggest what to do next.');
  return lines.join('\n');
}

/** Short line shown in the chat when a workflow ends. */
export function workflowEventText(workflow: WorkflowRun): string {
  const done = workflow.steps.filter((s) => s.status === 'finished').length;
  const verb = workflow.status === 'finished' ? 'finished' : workflow.status === 'cancelled' ? 'was cancelled' : 'failed';
  return `Workflow "${workflow.name}" ${verb} (${done}/${workflow.steps.length} steps done).`;
}
