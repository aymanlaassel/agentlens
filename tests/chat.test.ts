import { describe, expect, it } from 'vitest';
import {
  PERMISSION_LABEL,
  appendMessage,
  buildConductorPrompt,
  chatTitle,
  createChat,
  extractDirectives,
  updateMessage,
  workflowEventText,
  workflowHandback,
} from '../src/core';
import type { Chat, ChatMessage, RoleDefinition, WorkflowRun, WorkflowStep, WorkflowTemplate } from '../src/shared/types';

const T0 = 1_700_000_000_000;

const roles: RoleDefinition[] = [
  { id: 'planner', name: 'Planner', description: 'Breaks the goal into steps', systemPrompt: '', permission: 'read-only' },
  { id: 'coder', name: 'Coder', description: 'Implements the plan', systemPrompt: '', permission: 'edit' },
  { id: 'ops', name: 'Ops', description: 'Runs anything', systemPrompt: '', permission: 'full' },
];

const templates: WorkflowTemplate[] = [
  { id: 'plan-build', name: 'Plan and build', description: '', roleIds: ['planner', 'coder'] },
  { id: 'solo', name: 'Solo coder', description: '', roleIds: ['coder'] },
];

const fence = (body: string) => '```agentlens\n' + body + '\n```';

function step(over: Partial<WorkflowStep> & Pick<WorkflowStep, 'id' | 'roleId' | 'status'>): WorkflowStep {
  return { prompt: '', sessionId: `s-${over.id}`, ...over };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wf',
    name: 'Add dark mode',
    goal: 'Add dark mode',
    cwd: '/home/dev/app',
    status: 'finished',
    steps: [
      step({ id: 'a', roleId: 'planner', status: 'finished', output: 'Plan text' }),
      step({ id: 'b', roleId: 'coder', status: 'finished', output: 'Coder result' }),
    ],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return { kind: 'user', text: 'hello', at: T0 + 1, ...over };
}

function seedChat(): Chat {
  return createChat({ id: 'c1', cwd: '/home/dev/app', sessionId: 'sess', now: T0 });
}

describe('buildConductorPrompt', () => {
  const prompt = buildConductorPrompt(roles, templates);

  it('lists each role with its permission label and description', () => {
    for (const role of roles) {
      expect(prompt).toContain(`- ${role.id} (${PERMISSION_LABEL[role.permission]}): ${role.description}`);
    }
  });

  it('lists each template with its role sequence', () => {
    expect(prompt).toContain('plan-build: Plan and build — planner → coder');
    expect(prompt).toContain('solo: Solo coder — coder');
  });

  it('includes the directive example and the no-edit rule', () => {
    expect(prompt).toContain('```agentlens\n{"action":"run-workflow"');
    expect(prompt).toContain('never edit files');
  });

  it('tells the conductor when to use the PR templates', () => {
    expect(prompt).toContain('Use the pr-review-merge template only when the user explicitly asked to merge; otherwise use pr-review.');
    expect(prompt).toContain('state in the goal whether merging is authorized');
  });
});

describe('extractDirectives', () => {
  it('returns prose untouched when there is no block', () => {
    const result = extractDirectives('  Just an answer.  \n');
    expect(result).toEqual({ text: 'Just an answer.', directives: [], problems: [] });
  });

  it('strips a valid template directive', () => {
    const input = 'On it.\n\n' + fence('{"action":"run-workflow","templateId":"plan-build","goal":" Add dark mode "}') + '\n\n';
    const result = extractDirectives(input);
    expect(result.text).toBe('On it.');
    expect(result.problems).toEqual([]);
    expect(result.directives).toEqual([{ action: 'run-workflow', goal: 'Add dark mode', templateId: 'plan-build' }]);
    expect(result.directives[0]).not.toHaveProperty('roleIds');
  });

  it('accepts roleIds instead of templateId', () => {
    const result = extractDirectives(fence('{"action":"run-workflow","roleIds":["planner","coder"],"goal":"g"}'));
    expect(result.directives).toEqual([{ action: 'run-workflow', goal: 'g', roleIds: ['planner', 'coder'] }]);
    expect(result.directives[0]).not.toHaveProperty('templateId');
    expect(result.text).toBe('');
  });

  it('keeps a trimmed name', () => {
    const result = extractDirectives(fence('{"action":"run-workflow","templateId":"solo","goal":"g","name":"  Dark mode  "}'));
    expect(result.directives[0]?.name).toBe('Dark mode');
  });

  it('leaves invalid JSON in the text and reports it', () => {
    const input = 'Hi\n' + fence('{not json');
    const result = extractDirectives(input);
    expect(result.directives).toEqual([]);
    expect(result.text).toBe(input);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('not valid JSON');
  });

  it('rejects unknown actions', () => {
    const input = fence('{"action":"delete-everything","goal":"g","templateId":"solo"}');
    const result = extractDirectives(input);
    expect(result.directives).toEqual([]);
    expect(result.text).toBe(input);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('delete-everything');
  });

  it('requires a goal and a template or roles', () => {
    expect(extractDirectives(fence('{"action":"run-workflow","templateId":"solo"}')).problems).toEqual(['directive needs a goal']);
    expect(extractDirectives(fence('{"action":"run-workflow","goal":"   ","templateId":"solo"}')).problems).toEqual(['directive needs a goal']);
    const missing = extractDirectives(fence('{"action":"run-workflow","goal":"g","roleIds":[]}'));
    expect(missing.directives).toEqual([]);
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain('templateId');
  });

  it('extracts and removes multiple blocks', () => {
    const input = 'First\n' + fence('{"action":"run-workflow","templateId":"solo","goal":"one"}') + '\nSecond\n' + fence('{"action":"run-workflow","roleIds":["coder"],"goal":"two"}');
    const result = extractDirectives(input);
    expect(result.directives.map((d) => d.goal)).toEqual(['one', 'two']);
    expect(result.text).not.toContain('```');
    expect(result.text).toBe('First\n\nSecond');
  });

  it('parses blocks with CRLF line endings', () => {
    const input = 'Sure.\r\n```agentlens\r\n{"action":"run-workflow","templateId":"solo","goal":"g"}\r\n```';
    const result = extractDirectives(input);
    expect(result.problems).toEqual([]);
    expect(result.directives).toEqual([{ action: 'run-workflow', goal: 'g', templateId: 'solo' }]);
    expect(result.text).toBe('Sure.');
  });

  it('collapses blank lines left behind by a removed block', () => {
    const input = 'Before\n\n' + fence('{"action":"run-workflow","templateId":"solo","goal":"g"}') + '\n\nAfter';
    const result = extractDirectives(input);
    expect(result.text).toBe('Before\n\nAfter');
  });
});

describe('chatTitle', () => {
  it('uses the first line with whitespace collapsed', () => {
    expect(chatTitle('  Fix   the\tlogin bug\nmore details here')).toBe('Fix the login bug');
  });

  it('drops trailing whitespace and CRLF from the first line', () => {
    expect(chatTitle('Fix the bug  \nmore')).toBe('Fix the bug');
    expect(chatTitle('Hello\r\nworld')).toBe('Hello');
  });

  it('truncates long lines to 48 chars with an ellipsis', () => {
    const title = chatTitle('word '.repeat(30));
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith('…')).toBe(true);
    expect(chatTitle('x'.repeat(48))).toBe('x'.repeat(48));
    expect(chatTitle('x'.repeat(49))).toBe('x'.repeat(47) + '…');
  });

  it('falls back to New chat when empty', () => {
    expect(chatTitle('')).toBe('New chat');
    expect(chatTitle('   \n  ')).toBe('New chat');
  });
});

describe('createChat', () => {
  it('fills defaults', () => {
    expect(seedChat()).toEqual({
      id: 'c1',
      title: 'New chat',
      cwd: '/home/dev/app',
      sessionId: 'sess',
      sessionStarted: false,
      status: 'idle',
      messages: [],
      createdAt: T0,
      updatedAt: T0,
    });
  });

  it('trims an explicit title and ignores a blank one', () => {
    expect(createChat({ id: 'c', cwd: '/x', sessionId: 's', title: '  Refactor  ', now: T0 }).title).toBe('Refactor');
    expect(createChat({ id: 'c', cwd: '/x', sessionId: 's', title: '   ', now: T0 }).title).toBe('New chat');
  });
});

describe('appendMessage', () => {
  it('retitles a new chat from the first user message', () => {
    const chat = seedChat();
    const next = appendMessage(chat, msg({ id: 'm1', text: 'Add dark mode\nplease', at: T0 + 5 }));
    expect(next.title).toBe('Add dark mode');
    expect(next.messages).toHaveLength(1);
    expect(next.updatedAt).toBe(T0 + 5);
    expect(chat.messages).toEqual([]);
    expect(chat.title).toBe('New chat');
    expect(chat.updatedAt).toBe(T0);
  });

  it('does not retitle on later messages', () => {
    const first = appendMessage(seedChat(), msg({ id: 'm1', kind: 'assistant', text: 'Hi there' }));
    const second = appendMessage(first, msg({ id: 'm2', text: 'Something else', at: T0 + 9 }));
    expect(second.title).toBe('New chat');
    expect(second.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(second.updatedAt).toBe(T0 + 9);
  });

  it('does not retitle when the first message is an event', () => {
    const next = appendMessage(seedChat(), msg({ id: 'e1', kind: 'event', text: 'Workflow started' }));
    expect(next.title).toBe('New chat');
  });

  it('keeps a custom title', () => {
    const chat = createChat({ id: 'c', cwd: '/x', sessionId: 's', title: 'Mine', now: T0 });
    expect(appendMessage(chat, msg({ id: 'm1', text: 'Other' })).title).toBe('Mine');
  });
});

describe('updateMessage', () => {
  it('patches a message by id', () => {
    const chat = appendMessage(seedChat(), msg({ id: 'm1', kind: 'assistant', text: 'partial', pending: true }));
    const next = updateMessage(chat, 'm1', { text: 'done', pending: false }, T0 + 50);
    expect(next.messages[0]).toMatchObject({ id: 'm1', kind: 'assistant', text: 'done', pending: false });
    expect(next.updatedAt).toBe(T0 + 50);
    expect(chat.messages[0]).toMatchObject({ text: 'partial', pending: true });
    expect(chat.updatedAt).toBe(T0 + 1);
  });

  it('returns the same chat for an unknown id', () => {
    const chat = appendMessage(seedChat(), msg({ id: 'm1' }));
    expect(updateMessage(chat, 'nope', { text: 'x' }, T0 + 50)).toBe(chat);
  });
});

describe('workflowHandback', () => {
  it('summarises steps and the final output', () => {
    const text = workflowHandback(run(), roles);
    expect(text).toContain('Workflow "Add dark mode" finished.');
    expect(text).toContain('- Planner: finished');
    expect(text).toContain('- Coder: finished');
    expect(text).toContain('Final output (Coder):');
    expect(text).toContain('Coder result');
    expect(text).not.toContain('Plan text');
    expect(text).not.toContain('Error:');
    expect(text).toContain('Summarise this for the user');
  });

  it('falls back to role ids, adds step errors and uses the last step with output', () => {
    const wf = run({
      status: 'errored',
      error: 'Step 2 failed',
      steps: [
        step({ id: 'a', roleId: 'planner', status: 'finished', output: 'Plan text' }),
        step({ id: 'b', roleId: 'mystery', status: 'errored', error: 'Boom happened\nstack trace line' }),
      ],
    });
    const text = workflowHandback(wf, roles);
    expect(text).toContain('Workflow "Add dark mode" errored.');
    expect(text).toContain('- mystery: errored — Boom happened');
    expect(text).not.toContain('stack trace line');
    expect(text).toContain('Final output (Planner):');
    expect(text).toContain('Plan text');
    expect(text).toContain('Error: Step 2 failed');
  });

  it('truncates very long output', () => {
    const long = 'y'.repeat(7000);
    const text = workflowHandback(run({ steps: [step({ id: 'a', roleId: 'coder', status: 'finished', output: long })] }), roles);
    expect(text).toContain('y'.repeat(6000) + '\n…(truncated)');
    expect(text).not.toContain('y'.repeat(6001));
  });

  it('omits the output section when no step produced output', () => {
    const text = workflowHandback(run({ status: 'cancelled', steps: [step({ id: 'a', roleId: 'coder', status: 'cancelled' })] }), roles);
    expect(text).not.toContain('Final output');
    expect(text).toContain('- Coder: cancelled');
  });
});

describe('workflowEventText', () => {
  it('describes each terminal status', () => {
    expect(workflowEventText(run())).toBe('Workflow "Add dark mode" finished (2/2 steps done).');
    const partial = [step({ id: 'a', roleId: 'planner', status: 'finished' }), step({ id: 'b', roleId: 'coder', status: 'cancelled' })];
    expect(workflowEventText(run({ status: 'cancelled', steps: partial }))).toBe('Workflow "Add dark mode" was cancelled (1/2 steps done).');
    expect(workflowEventText(run({ status: 'errored', steps: partial }))).toBe('Workflow "Add dark mode" failed (1/2 steps done).');
  });
});
