import type { RoleDefinition, RolePermission, WorkflowTemplate } from '../shared/types';

/**
 * Tools a role may use at each permission level. The base presets stay offline;
 * only the pr-analyst and pr-merger roles call the GitHub CLI (gh), which
 * requires the user to have gh installed and authenticated.
 */
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite'];
const EDIT_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)'];

export const PERMISSION_LABEL: Record<RolePermission, string> = {
  'read-only': 'Read only',
  edit: 'Edit files',
  full: 'Full access',
};

export const PERMISSION_HELP: Record<RolePermission, string> = {
  'read-only': 'Can read and search files. Cannot change anything, and runs only the commands listed in extraTools.',
  edit: 'Can edit files and run tests or git read commands inside the working directory.',
  full: 'Can run any shell command without asking. Use only for roles you trust with your machine.',
};

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Reads the codebase and writes a step-by-step plan.',
    systemPrompt:
      'You are the Planner in a team of agents. Study the working directory and produce a concrete, ordered implementation plan for the goal. ' +
      'Name the files to change and what to change in each. Do not modify anything. Finish with a section titled "Plan" that the next agent can execute verbatim.',
    permission: 'read-only',
    maxTurns: 30,
    builtIn: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Implements the plan it is given and runs the tests.',
    systemPrompt:
      'You are the Coder in a team of agents. Implement the plan you are given in the working directory. ' +
      'Make the changes, run the relevant tests, and fix failures. Finish with a section titled "Changes" listing every file you touched and anything left undone.',
    permission: 'edit',
    maxTurns: 80,
    builtIn: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews the changes for bugs and reports findings.',
    systemPrompt:
      'You are the Reviewer in a team of agents. Inspect the changes described to you (use git diff) and look for correctness bugs, missed cases, and anything that contradicts the goal. ' +
      'Do not modify files. Finish with a section titled "Verdict" that says APPROVE or REQUEST CHANGES, followed by a numbered list of findings.',
    permission: 'read-only',
    maxTurns: 30,
    builtIn: true,
  },
  {
    id: 'operator',
    name: 'Operator',
    description: 'Carries out tasks on the computer with full shell access.',
    systemPrompt:
      'You are the Operator in a team of agents. Carry out the task on this computer using the shell and file tools. ' +
      'Work inside the working directory unless the task says otherwise. Never delete data you were not asked to delete. Finish with a section titled "Done" summarising what you did.',
    permission: 'full',
    maxTurns: 60,
    builtIn: true,
  },
  {
    id: 'pr-analyst',
    name: 'PR analyst',
    description: 'Inspects a pull request with the GitHub CLI and reports a verdict.',
    systemPrompt:
      'You are the PR analyst in a team of agents. The goal names a pull request by number, URL, or branch. ' +
      'Run `gh pr view`, `gh pr diff`, and `gh pr checks` on it to inspect the title, description, diff, CI status, and review state. ' +
      'Read the touched files in the working directory for context. Look for correctness bugs, missing tests, risky changes, and anything that contradicts the PR description. ' +
      'Never modify files. Finish with a section titled "Verdict" containing exactly APPROVE or REQUEST CHANGES on its own line, then "PR: <number>" on its own line, ' +
      'then a numbered list of findings with file and line references.',
    permission: 'read-only',
    extraTools: ['Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)'],
    maxTurns: 40,
    builtIn: true,
  },
  {
    id: 'pr-merger',
    name: 'PR merger',
    description: 'Merges a pull request only when the goal authorizes it and the analyst approved.',
    systemPrompt:
      "You are the PR merger in a team of agents. You receive the PR analyst's output from the previous step. " +
      'Merge ONLY IF ALL of these hold: (a) the goal text explicitly authorizes merging with a clear instruction such as "merge if approved" or "you may merge"; ' +
      "(b) the previous step's Verdict is APPROVE; (c) `gh pr checks` shows no failing or pending required checks. " +
      'Use `gh pr merge <number> --squash --delete-branch` unless the goal names a different merge method. ' +
      'If any condition fails, do not merge and explain which condition blocked it. ' +
      'Finish with a section titled "Merge result" saying MERGED or NOT MERGED and why.',
    permission: 'read-only',
    extraTools: ['Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr merge:*)'],
    maxTurns: 15,
    builtIn: true,
  },
];

export const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  { id: 'plan-build-review', name: 'Plan, build, review', description: 'Planner writes a plan, Coder implements it, Reviewer checks the result.', roleIds: ['planner', 'coder', 'reviewer'], builtIn: true },
  { id: 'plan-build', name: 'Plan and build', description: 'Planner then Coder.', roleIds: ['planner', 'coder'], builtIn: true },
  { id: 'build', name: 'Build', description: 'Coder alone.', roleIds: ['coder'], builtIn: true },
  { id: 'operate', name: 'Operate', description: 'Operator carries out a task with full access.', roleIds: ['operator'], builtIn: true },
  { id: 'pr-review', name: 'Review pull request', description: 'PR analyst inspects a pull request and reports a verdict.', roleIds: ['pr-analyst'], builtIn: true },
  { id: 'pr-review-merge', name: 'Review and merge pull request', description: 'PR analyst reviews, then PR merger merges only if the goal authorizes it and the verdict is APPROVE.', roleIds: ['pr-analyst', 'pr-merger'], builtIn: true },
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Returns a problem description, or undefined when the role is usable. */
export function validateRole(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return 'role must be an object';
  const role = raw as Record<string, unknown>;
  if (typeof role.id !== 'string' || !ID_PATTERN.test(role.id)) return 'id must be lowercase letters, digits, or dashes';
  if (typeof role.name !== 'string' || !role.name.trim()) return 'name is required';
  if (typeof role.systemPrompt !== 'string' || !role.systemPrompt.trim()) return 'systemPrompt is required';
  if (role.permission !== 'read-only' && role.permission !== 'edit' && role.permission !== 'full') return 'permission must be read-only, edit, or full';
  if (role.extraTools !== undefined && (!Array.isArray(role.extraTools) || role.extraTools.some((t) => typeof t !== 'string'))) return 'extraTools must be a list of strings';
  if (role.maxTurns !== undefined && (typeof role.maxTurns !== 'number' || role.maxTurns < 1 || role.maxTurns > 500)) return 'maxTurns must be between 1 and 500';
  if (role.model !== undefined && typeof role.model !== 'string') return 'model must be a string';
  return undefined;
}

/** Merge user roles over the built-in ones. Invalid entries are dropped and reported. */
export function mergeRoles(custom: unknown): { roles: RoleDefinition[]; problems: string[] } {
  const byId = new Map(DEFAULT_ROLES.map((r) => [r.id, r]));
  const problems: string[] = [];
  if (Array.isArray(custom)) {
    custom.forEach((raw, index) => {
      const problem = validateRole(raw);
      if (problem) {
        problems.push(`roles[${index}]: ${problem}`);
        return;
      }
      const role = raw as RoleDefinition;
      byId.set(role.id, { ...role, description: role.description ?? '', builtIn: false });
    });
  }
  return { roles: [...byId.values()], problems };
}

/** Claude Code CLI flags that enforce a role's permission level. */
export function permissionArgs(role: Pick<RoleDefinition, 'permission' | 'extraTools'>): string[] {
  const extra = role.extraTools ?? [];
  switch (role.permission) {
    case 'read-only': {
      // Specific Bash(...) extras are enforced by the allowed list under dontAsk; bare Bash would block them all.
      const hasBashExtras = extra.some((t) => t.startsWith('Bash('));
      return ['--permission-mode', 'dontAsk', '--allowedTools', ...READ_TOOLS, ...extra, '--disallowedTools', ...(hasBashExtras ? [] : ['Bash']), 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
    }
    case 'edit':
      return ['--permission-mode', 'acceptEdits', '--allowedTools', ...EDIT_TOOLS, ...extra, '--disallowedTools', 'WebFetch', 'WebSearch'];
    case 'full':
      return ['--permission-mode', 'bypassPermissions', ...(extra.length ? ['--allowedTools', ...extra] : [])];
  }
}

/** True when the role is allowed to run `gh pr merge`, which the allowPrMerge setting gates. */
export function roleCanMerge(role: Pick<RoleDefinition, 'extraTools'>): boolean {
  return (role.extraTools ?? []).some((t) => /^Bash\(gh pr merge/.test(t));
}

/** Full argument list for one headless Claude Code step. */
export function stepArgs(role: RoleDefinition, sessionId: string, prompt: string): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--append-system-prompt', role.systemPrompt, ...permissionArgs(role)];
  if (role.model) args.push('--model', role.model);
  if (role.maxTurns) args.push('--max-turns', String(role.maxTurns));
  return args;
}

/** Prompt handed to a role: the goal, plus what the previous role produced. */
export function buildStepPrompt(goal: string, previous: { roleName: string; output: string } | undefined, position: { index: number; total: number }): string {
  const lines = [`Goal: ${goal.trim()}`, '', `You are step ${position.index + 1} of ${position.total} in this workflow.`];
  if (previous) {
    lines.push('', `Output from the previous step (${previous.roleName}):`, '', '---', previous.output.trim(), '---');
  }
  return lines.join('\n');
}
