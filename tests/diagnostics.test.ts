import { describe, expect, it } from 'vitest';
import { analyzeRun } from '../src/core/diagnostics';
import type { AgentDetail, RunDetail, ToolCall } from '../src/shared/types';

function call(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'Bash', kind: 'shell', summary: 'PRIVATE COMMAND', ...overrides };
}

function agent(id: string, overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id, runId: 'run', provider: 'claude', role: 'subagent', depth: 1,
    title: 'PRIVATE TITLE', prompt: 'PRIVATE PROMPT', status: 'running',
    toolCallCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageByModel: [], filesTouched: [], toolCalls: [], timeline: [], todos: [], ...overrides,
  };
}

function run(agents: AgentDetail[]): RunDetail {
  return {
    run: { id: 'run', provider: 'claude', title: 'PRIVATE TITLE', projectName: 'app',
      projectPath: '/home/dev/app', cwd: '/home/dev/app', filePath: '/home/dev/log.jsonl',
      status: 'running', agentCount: agents.length, tokensLoaded: true, isEmpty: false },
    agents,
  };
}

describe('analyzeRun', () => {
  it('counts the whole run and reports log errors without copying transcript text', () => {
    const detail = run([
      agent('a', { status: 'errored', error: 'PRIVATE ERROR', filesTouched: ['src/a.ts'],
        toolCalls: [call('c1', { isError: true, resultPreview: 'PRIVATE RESULT', endedAt: 50 })] }),
      agent('b', { status: 'finished', filesTouched: ['src/a.ts', 'src/b.ts'] }),
      agent('c', { status: 'idle', toolCalls: [call('c2', { startedAt: 90 })] }),
    ]);
    const result = analyzeRun(detail, { now: 100, idleWindowMs: 20 });
    expect(result.counts).toEqual({ agents: 3, running: 0, idle: 1, finished: 1, errored: 1,
      toolCalls: 2, failedToolCalls: 1, pendingToolCalls: 1, filesTouched: 2 });
    expect(result.findings.map((f) => f.code)).toEqual(['agent-error', 'failed-tools']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('flags consecutive failed calls as a heuristic, and a success resets the sequence', () => {
    const calls = [call('a', { isError: true }), call('b', { isError: true }), call('c', { isError: true })];
    expect(analyzeRun(run([agent('a', { toolCalls: calls })])).findings).toContainEqual(expect.objectContaining({
      code: 'repeated-failures', confidence: 'heuristic', count: 3, toolName: 'Bash', toolIds: ['a', 'b', 'c'],
    }));
    calls.push(call('d', { endedAt: 10 }));
    expect(analyzeRun(run([agent('a', { toolCalls: calls })])).findings.some((f) => f.code === 'repeated-failures')).toBe(false);
  });

  it('does not combine failures from different tools into a repeated failure', () => {
    const calls = [call('a', { isError: true }), call('b', { name: 'Read', isError: true }), call('c', { isError: true })];
    expect(analyzeRun(run([agent('a', { toolCalls: calls })])).findings.some((f) => f.code === 'repeated-failures')).toBe(false);
  });

  it('reports quiet pending tools only when the latest observed activity crosses the threshold', () => {
    const detail = run([agent('a', { status: 'idle', lastActivityAt: 100, toolCalls: [call('c', { startedAt: 120 })] })]);
    expect(analyzeRun(detail, { now: 139, idleWindowMs: 20 }).findings).toEqual([]);
    expect(analyzeRun(detail, { now: 140, idleWindowMs: 20 }).findings).toContainEqual(expect.objectContaining({
      code: 'quiet-pending-tools', silentForMs: 20, confidence: 'heuristic', count: 1,
    }));
    expect(analyzeRun(detail, { now: 90, idleWindowMs: 20 }).findings).toEqual([]);
  });

  it('does not infer quiet tools from missing timestamps or terminal agents', () => {
    const result = analyzeRun(run([
      agent('a', { toolCalls: [call('a')] }),
      agent('b', { status: 'finished', lastActivityAt: 0, toolCalls: [call('b', { startedAt: 0 })] }),
      agent('c', { status: 'errored', lastActivityAt: 0, toolCalls: [call('c', { startedAt: 0 })] }),
    ]), { now: 100, idleWindowMs: 20 });
    expect(result.findings.some((f) => f.code === 'quiet-pending-tools')).toBe(false);
    expect(result.counts.pendingToolCalls).toBe(1);
  });

  it('finds overlapping edit windows across agents, not sequential edits or reads', () => {
    const edit = (id: string, file: string, startedAt: number, endedAt: number) =>
      call(id, { kind: 'edit', name: 'Edit', file, startedAt, endedAt });
    const detail = run([
      agent('a', { toolCalls: [edit('a1', 'same.ts', 10, 30), edit('a2', 'sequential.ts', 0, 10),
        edit('a3', 'same-agent.ts', 0, 100), edit('a4', 'same-agent.ts', 10, 20)] }),
      agent('b', { toolCalls: [edit('b1', 'same.ts', 20, 40), edit('b2', 'sequential.ts', 10, 20),
        call('b3', { kind: 'read', file: 'same-agent.ts', startedAt: 10, endedAt: 20 })] }),
    ]);
    const overlaps = analyzeRun(detail, { now: 100 }).findings.filter((f) => f.code === 'overlapping-writes');
    expect(overlaps).toEqual([expect.objectContaining({ file: 'same.ts', agentIds: ['a', 'b'], confidence: 'heuristic' })]);
  });

  it('keeps a long overlapping interval when newer edits from the same agent finish earlier', () => {
    const edit = (id: string, startedAt: number, endedAt: number) => call(id, { kind: 'edit', file: 'a.ts', startedAt, endedAt });
    const detail = run([
      agent('a', { toolCalls: [edit('a1', 0, 100), edit('a2', 10, 20)] }),
      agent('b', { toolCalls: [edit('b1', 50, 60)] }),
    ]);
    expect(analyzeRun(detail).findings).toContainEqual(expect.objectContaining({ code: 'overlapping-writes', toolIds: ['a1', 'b1'] }));
  });

  it('does not extend incomplete edit windows from terminal logs or report failed edits as writes', () => {
    const edit = (id: string, overrides: Partial<ToolCall>) => call(id, { kind: 'edit', file: 'a.ts', startedAt: 0, ...overrides });
    const result = analyzeRun(run([
      agent('a', { status: 'finished', toolCalls: [edit('a', {})] }),
      agent('b', { toolCalls: [edit('b', { endedAt: 100, isError: true })] }),
      agent('c', { toolCalls: [edit('c', { startedAt: 50, endedAt: 100 })] }),
    ]), { now: 200 });
    expect(result.findings.some((f) => f.code === 'overlapping-writes')).toBe(false);
  });

  it('bounds findings and evidence while preserving totals', () => {
    const detail = run(Array.from({ length: 110 }, (_, i) => agent(`a${i}`, {
      status: 'errored', toolCalls: Array.from({ length: 20 }, (_, j) => call(`t${j}`, { isError: true })),
    })));
    const result = analyzeRun(detail, { maxFindings: 2, now: 100 });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.toolIds).toHaveLength(8);
    expect(result.totalFindings).toBe(330);
    expect(result.truncated).toBe(true);
    expect(result.counts.failedToolCalls).toBe(2200);
    expect(analyzeRun(detail, { maxFindings: 500 }).findings).toHaveLength(100);
    expect(analyzeRun(detail, { maxFindings: -1 }).findings).toEqual([]);
  });
});
