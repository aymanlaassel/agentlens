import type { AgentDetail, AgentStatus, RunDetail, ToolCall } from '../shared/types';

export type RunFindingCode = 'agent-error' | 'failed-tools' | 'repeated-failures' | 'quiet-pending-tools' | 'overlapping-writes';

export interface RunFinding {
  code: RunFindingCode;
  severity: 'error' | 'warning';
  /** Observed means a log signal, not independent verification of a tool's outcome. */
  confidence: 'observed' | 'heuristic';
  message: string;
  agentIds: string[];
  toolIds?: string[];
  toolName?: string;
  file?: string;
  count?: number;
  silentForMs?: number;
}

export interface RunDiagnostics {
  runId: string;
  analyzedAt: number;
  counts: {
    agents: number;
    running: number;
    idle: number;
    finished: number;
    errored: number;
    toolCalls: number;
    failedToolCalls: number;
    pendingToolCalls: number;
    filesTouched: number;
  };
  findings: RunFinding[];
  totalFindings: number;
  truncated: boolean;
}

export interface AnalyzeRunOptions {
  now?: number;
  /** Silence is only a hint: long-running tools and incomplete logs are normal. */
  idleWindowMs?: number;
  /** Maximum returned findings, clamped to 0–100 (default 50). */
  maxFindings?: number;
}

interface WriteWindow {
  agentId: string;
  toolId: string;
  start: number;
  end: number;
}

const MAX_RELATED_IDS = 8;
const isTerminal = (status: AgentStatus): boolean => status === 'finished' || status === 'errored';
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
const id = (value: string): string => value.slice(0, 256);

function pendingCalls(agent: AgentDetail): ToolCall[] {
  if (isTerminal(agent.status)) return [];
  return agent.toolCalls.filter((call) => call.endedAt === undefined && !call.isError);
}

function latestActivity(agent: AgentDetail): number | undefined {
  let latest = finite(agent.lastActivityAt) ? agent.lastActivityAt : undefined;
  for (const call of agent.toolCalls) {
    for (const at of [call.startedAt, call.endedAt]) {
      if (finite(at) && (latest === undefined || at > latest)) latest = at;
    }
  }
  return latest;
}

/**
 * Evidence-based hints over an already-parsed run. Never executes tools or copies
 * prompts, shell commands, error text, or result previews into diagnostics.
 * Findings are bounded; counts always cover the entire supplied run.
 */
export function analyzeRun(detail: RunDetail, options: AnalyzeRunOptions = {}): RunDiagnostics {
  const now = finite(options.now) ? options.now : Date.now();
  const idleWindowMs = finite(options.idleWindowMs) && options.idleWindowMs > 0 ? options.idleWindowMs : 45_000;
  const limit = finite(options.maxFindings) ? Math.max(0, Math.min(100, Math.floor(options.maxFindings))) : 50;
  const counts: RunDiagnostics['counts'] = {
    agents: detail.agents.length, running: 0, idle: 0, finished: 0, errored: 0,
    toolCalls: 0, failedToolCalls: 0, pendingToolCalls: 0, filesTouched: 0,
  };
  const findings: RunFinding[] = [];
  let totalFindings = 0;
  const add = (finding: RunFinding): void => {
    totalFindings += 1;
    if (findings.length < limit) findings.push(finding);
  };
  const files = new Set<string>();
  const writes = new Map<string, WriteWindow[]>();

  for (const agent of detail.agents) {
    counts[agent.status] += 1;
    counts.toolCalls += agent.toolCalls.length;
    for (const file of agent.filesTouched) files.add(file);
    const agentIds = [id(agent.id)];

    if (agent.status === 'errored') {
      add({ code: 'agent-error', severity: 'error', confidence: 'observed', agentIds,
        message: 'This agent is marked errored in the session log. Inspect its latest event before continuing.' });
    }

    const failed = agent.toolCalls.filter((call) => call.isError);
    counts.failedToolCalls += failed.length;
    if (failed.length) {
      add({ code: 'failed-tools', severity: 'warning', confidence: 'observed', agentIds,
        toolIds: failed.slice(-MAX_RELATED_IDS).map((call) => id(call.id)), count: failed.length,
        message: 'Tool calls were marked as failed in the session log. Later successful work may have resolved them.' });
    }

    // A successful or different tool call breaks the sequence. Matching a tool
    // name alone does not prove identical inputs or an infinite retry loop.
    const lastCall = agent.toolCalls[agent.toolCalls.length - 1];
    if (lastCall?.isError) {
      let count = 0;
      for (let i = agent.toolCalls.length - 1; i >= 0; i -= 1) {
        const call = agent.toolCalls[i];
        if (!call?.isError || call.name !== lastCall.name) break;
        count += 1;
      }
      if (count >= 3) {
        add({ code: 'repeated-failures', severity: 'warning', confidence: 'heuristic', agentIds,
          toolName: lastCall.name.slice(0, 128), count,
          toolIds: agent.toolCalls.slice(-Math.min(count, MAX_RELATED_IDS)).map((call) => id(call.id)),
          message: 'The latest calls to one tool repeatedly failed. Inspect the results before retrying; their inputs may differ.' });
      }
    }

    const pending = pendingCalls(agent);
    counts.pendingToolCalls += pending.length;
    const lastActivity = latestActivity(agent);
    if (pending.length && lastActivity !== undefined && now - lastActivity >= idleWindowMs) {
      add({ code: 'quiet-pending-tools', severity: 'warning', confidence: 'heuristic', agentIds,
        toolIds: pending.slice(-MAX_RELATED_IDS).map((call) => id(call.id)), count: pending.length,
        silentForMs: now - lastActivity,
        message: 'Tools have no recorded result and there has been no recent log activity. They may still be running; this does not prove a stall.' });
    }

    for (const call of agent.toolCalls) {
      if (call.kind !== 'edit' || !call.file || call.isError || !finite(call.startedAt)) continue;
      // Missing results in finished logs cannot establish an ongoing write.
      const end = finite(call.endedAt) ? call.endedAt : isTerminal(agent.status) ? undefined : now;
      if (end === undefined || end <= call.startedAt) continue;
      const windows = writes.get(call.file) ?? [];
      windows.push({ agentId: agent.id, toolId: call.id, start: call.startedAt, end });
      writes.set(call.file, windows);
    }
  }

  for (const [file, windows] of writes) {
    if (windows.length < 2) continue;
    windows.sort((a, b) => a.start - b.start);
    // Keep the two furthest-ending intervals from distinct agents. One of them
    // is enough to establish overlap with a different agent in O(n) after sort.
    let furthest: WriteWindow | undefined;
    let second: WriteWindow | undefined;
    const agentIds = new Set<string>();
    const toolIds = new Set<string>();
    for (const window of windows) {
      const other = furthest?.agentId === window.agentId ? second : furthest;
      if (other && other.end > window.start) {
        for (const candidate of [other, window]) {
          if (agentIds.size < MAX_RELATED_IDS) agentIds.add(id(candidate.agentId));
          if (toolIds.size < MAX_RELATED_IDS) toolIds.add(id(candidate.toolId));
        }
      }
      if (furthest?.agentId === window.agentId) {
        if (window.end > furthest.end) furthest = window;
      } else if (!furthest || window.end > furthest.end) {
        second = furthest;
        furthest = window;
      } else if (!second || window.end > second.end) {
        second = window;
      }
    }
    if (agentIds.size > 1) {
      add({ code: 'overlapping-writes', severity: 'warning', confidence: 'heuristic',
        agentIds: [...agentIds], toolIds: [...toolIds], file: file.slice(0, 512),
        message: 'Recorded edit calls from different agents overlap on this file. Check the resulting diff for conflicting changes.' });
    }
  }

  counts.filesTouched = files.size;
  return { runId: id(detail.run.id), analyzedAt: now, counts, findings, totalFindings, truncated: totalFindings > findings.length };
}
