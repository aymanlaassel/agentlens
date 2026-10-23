import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { analyzeRun } from '../core/diagnostics';
import { discoverAll, loadRunDetail, RunIdentityError, RunScopeError, type DiscoveryResult } from '../main/discovery';
import type { AgentDetail, AgentStatus, Provider, RunDetail, RunSummary, Settings, TokenUsage } from '../shared/types';

const INDEX_TTL_MS = 2000;
const MAX_PAGE_SIZE = 100;

export class QueryError extends Error {}

export interface ReaderOptions {
  settings: Settings;
  /** An explicit local directory. Descendant working directories are included. */
  project: string;
  allProjects?: boolean;
  allowText?: boolean;
}

export interface PageOptions {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ListOptions extends PageOptions {
  provider?: Provider | undefined;
  status?: AgentStatus | undefined;
  includeText?: boolean | undefined;
}

function canonicalPath(path: string): string {
  // Resolve the nearest surviving ancestor too: a historical path underneath a
  // symlink must not bypass scope just because its final directory was removed.
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

export function pathWithin(project: string, path: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  const rel = relative(project, canonicalPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function bounded(text: unknown, size = 240): string | undefined {
  if (typeof text !== 'string') return undefined;
  return text.length > size ? text.slice(0, size) + '…' : text;
}

function tokenMetadata(tokens: TokenUsage): TokenUsage {
  // Parsers tolerate live JSONL and cannot establish runtime types for every
  // field. Never pass malformed strings/objects through the metadata boundary.
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return { input: count(tokens.input), output: count(tokens.output), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheWrite) };
}

function page(options: PageOptions): { limit: number; offset: number } {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new QueryError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new QueryError('offset must be an integer from 0 to 1000000');
  return { limit, offset };
}

function runMetadata(run: RunSummary, includeText: boolean) {
  return {
    id: bounded(run.id, 300),
    provider: run.provider,
    projectPath: bounded(run.projectPath, 500),
    status: run.status,
    agentCount: run.agentCount,
    model: bounded(run.model, 100),
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    tokens: run.tokens ? tokenMetadata(run.tokens) : undefined,
    tokensLoaded: run.tokensLoaded,
    ...(includeText ? { title: bounded(run.title), gitBranch: bounded(run.gitBranch, 100) } : {}),
  };
}

function agentMetadata(agent: AgentDetail, includeText: boolean) {
  return {
    id: bounded(agent.id, 300),
    parentId: bounded(agent.parentId, 300),
    role: agent.role,
    depth: Number.isSafeInteger(agent.depth) && agent.depth >= 0 ? agent.depth : agent.role === 'main' ? 0 : 1,
    status: agent.status,
    model: bounded(agent.model, 100),
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    endedAt: agent.endedAt,
    toolCallCount: agent.toolCallCount,
    failedToolCalls: agent.toolCalls.filter((call) => call.isError).length,
    pendingToolCalls: agent.status === 'finished' || agent.status === 'errored' ? 0 : agent.toolCalls.filter((call) => call.endedAt === undefined && !call.isError).length,
    tokens: tokenMetadata(agent.tokens),
    filesTouchedCount: agent.filesTouched.length,
    filesTouched: agent.filesTouched.slice(0, 10).map((file) => bounded(file, 300)),
    ...(includeText ? {
      title: bounded(agent.title),
      currentAction: bounded(agent.currentAction),
      nowTodo: bounded(agent.nowTodo),
      error: bounded(agent.error),
      lastAssistantText: bounded(agent.lastAssistantText, 600),
    } : {}),
  };
}

/**
 * On-demand, read-only access to the same parsers as the desktop app. No Electron,
 * server socket, background watcher, or transcript persistence is needed.
 */
export class SessionReader {
  readonly project: string;
  private index: { value: DiscoveryResult; expires: number } | undefined;
  private scanning: Promise<DiscoveryResult> | undefined;
  private loading = new Map<string, Promise<RunDetail>>();

  constructor(private readonly options: ReaderOptions) {
    try {
      this.project = realpathSync(resolve(options.project));
      if (!statSync(this.project).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new QueryError('Project directory does not exist or is not readable');
    }
  }

  private async getIndex(): Promise<DiscoveryResult> {
    if (this.index && this.index.expires > Date.now()) return this.index.value;
    if (this.scanning) return this.scanning;
    this.scanning = discoverAll(this.options.settings, { acceptRun: (run) => this.visible(run) });
    try {
      const value = await this.scanning;
      this.index = { value, expires: Date.now() + INDEX_TTL_MS };
      return value;
    } finally {
      this.scanning = undefined;
    }
  }

  private visible(run: RunSummary): boolean {
    return !!this.options.allProjects || pathWithin(this.project, run.cwd) || pathWithin(this.project, run.projectPath);
  }

  private checkText(includeText: boolean | undefined): boolean {
    if (includeText && !this.options.allowText) throw new QueryError('Transcript excerpts are disabled. Restart AgentLens with --include-text to opt in.');
    return includeText === true;
  }

  private async detail(runId: string): Promise<RunDetail> {
    if (!runId || runId.length > 300) throw new QueryError('A valid runId from agentlens_list_runs is required');
    const index = await this.getIndex();
    const run = index.runs.find((candidate) => candidate.id === runId && this.visible(candidate));
    const location = run && index.locations.get(run.id);
    if (!run || !location) throw new QueryError('Run not found in the configured project. List runs again to refresh the available IDs.');
    const pending = this.loading.get(runId);
    if (pending) return pending;
    const promise = loadRunDetail(location, this.options.settings, Date.now(), { acceptRun: (candidate) => this.visible(candidate) }).then((detail) => {
      if (!this.visible(detail.run)) throw new QueryError('Run is no longer in the configured project');
      if (detail.run.id !== run.id || detail.run.provider !== run.provider) throw new QueryError('Run identity changed. List runs again to refresh the available IDs.');
      return detail;
    }).catch((error: unknown) => {
      if (error instanceof QueryError) throw error;
      if (error instanceof RunScopeError || error instanceof RunIdentityError) throw new QueryError(error.message);
      throw new QueryError('Could not read this run. Its session files may have moved or been removed.');
    });
    this.loading.set(runId, promise);
    try {
      return await promise;
    } finally {
      this.loading.delete(runId);
    }
  }

  async listRuns(options: ListOptions = {}) {
    const includeText = this.checkText(options.includeText);
    const { limit, offset } = page(options);
    const index = await this.getIndex();
    const runs = index.runs
      .filter((run) => this.visible(run) && (!options.provider || run.provider === options.provider) && (!options.status || run.status === options.status))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id));
    return {
      project: this.options.allProjects ? null : this.project,
      total: runs.length,
      offset,
      nextOffset: offset + limit < runs.length ? offset + limit : null,
      textIncluded: includeText,
      runs: runs.slice(offset, offset + limit).map((run) => runMetadata(run, includeText)),
    };
  }

  async inspectRun(runId: string, options: PageOptions & { includeText?: boolean | undefined } = {}) {
    const includeText = this.checkText(options.includeText);
    const { limit, offset } = page(options);
    const detail = await this.detail(runId);
    return {
      run: runMetadata(detail.run, includeText),
      totalAgents: detail.agents.length,
      offset,
      nextOffset: offset + limit < detail.agents.length ? offset + limit : null,
      textIncluded: includeText,
      agents: detail.agents.slice(offset, offset + limit).map((agent) => agentMetadata(agent, includeText)),
    };
  }

  async diagnoseRun(runId: string, maxFindings = 30) {
    if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > 100) throw new QueryError('maxFindings must be an integer from 1 to 100');
    const detail = await this.detail(runId);
    return analyzeRun(detail, { idleWindowMs: this.options.settings.activeWindowSeconds * 1000, maxFindings });
  }

  async doctor() {
    const index = await this.getIndex();
    const visible = index.runs.filter((run) => this.visible(run));
    return {
      project: this.options.allProjects ? null : this.project,
      readOnly: true,
      transcriptTextEnabled: this.options.allowText === true,
      activeWindowSeconds: this.options.settings.activeWindowSeconds,
      sources: index.sources.map((source) => ({
        provider: source.provider,
        path: source.path,
        exists: source.exists,
        runsInScope: visible.filter((run) => run.provider === source.provider).length,
        ...(!source.exists ? { hint: `No session directory found. Run ${source.provider === 'claude' ? 'Claude Code' : 'Codex'} locally or set --${source.provider}-dir.` } : {}),
      })),
      note: 'Status is inferred from session logs, not process liveness. Results may lag file changes by up to two seconds. Inspect one run for token totals and diagnostics.',
    };
  }
}
