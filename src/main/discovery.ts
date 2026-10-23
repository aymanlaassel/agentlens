import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseClaudeHeader, parseClaudeSession, parseJsonl, parseSubagentMeta, parseCodexSession, resolveProject, type SubagentFile } from '../core';
import type { DiscoverySource, Provider, RunDetail, RunSummary, Settings } from '../shared/types';
import { isDirectory, isGitRoot, listDir, readHeadTail, readText, walkJsonl } from './files';

export interface RunLocation {
  id: string;
  provider: Provider;
  filePath: string;
  /** Claude only: directory holding `subagents/` for this session. */
  sessionDir?: string;
}

export interface DiscoveryResult {
  runs: RunSummary[];
  locations: Map<string, RunLocation>;
  sources: DiscoverySource[];
}

export class RunIdentityError extends Error {
  constructor() {
    super('Run identity changed. List runs again to refresh the available IDs.');
    this.name = 'RunIdentityError';
  }
}

export interface DiscoveryOptions {
  /** Optional project boundary for headless readers. Desktop discovery is unfiltered. */
  acceptRun?: (run: RunSummary) => boolean;
}

/** Distinguish changed project metadata from a file that could not be read. */
export class RunScopeError extends Error {
  constructor() {
    super('Run is no longer in the configured project');
    this.name = 'RunScopeError';
  }
}

function activeWindowMs(settings: Settings): number {
  return settings.activeWindowSeconds * 1000;
}

async function listSubagentFiles(sessionDir: string): Promise<string[]> {
  const dir = join(sessionDir, 'subagents');
  const names = await listDir(dir);
  return names.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).map((n) => join(dir, n));
}

/** Latest explicit main-session identity; older inherited/sidechain records may differ. */
function latestClaudeSessionId(text: string): string | undefined {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const record = parseJsonl(text.slice(start, end))[0];
    if (record && !record.isSidechain && typeof record.sessionId === 'string' && record.sessionId) return record.sessionId;
    end = start - 1;
  }
  return undefined;
}

export async function claudeHeader(filePath: string, settings: Settings, now = Date.now(), options: DiscoveryOptions = {}): Promise<{ run: RunSummary; location: RunLocation } | undefined> {
  const sessionId = basename(filePath, '.jsonl');
  if (sessionId.startsWith('agent-')) return undefined;
  const sessionDir = filePath.slice(0, -'.jsonl'.length);
  try {
    const [chunks, subFiles] = await Promise.all([readHeadTail(filePath), listSubagentFiles(sessionDir)]);
    const run = parseClaudeHeader({
      sessionId,
      filePath,
      headText: chunks.head,
      tailText: chunks.tail,
      mtimeMs: chunks.mtimeMs,
      subagentCount: subFiles.length,
      now,
      activeWindowMs: activeWindowMs(settings),
      isGitRoot,
      homeDir: homedir(),
    });
    const acceptRun = options.acceptRun;
    if (acceptRun) {
      if (!acceptRun(run)) return undefined;
      const accepted = await mapLimit(subFiles, 16, async (path) => {
        try {
          const child = await readHeadTail(path);
          const header = parseClaudeHeader({ sessionId: basename(path, '.jsonl'), filePath: path, headText: child.head, tailText: child.tail, mtimeMs: child.mtimeMs, subagentCount: 0, now, activeWindowMs: activeWindowMs(settings), isGitRoot, homeDir: homedir() });
          return !header.cwd || acceptRun(header);
        } catch {
          return false;
        }
      });
      run.agentCount = 1 + accepted.filter(Boolean).length;
    }
    return { run, location: { id: sessionId, provider: 'claude', filePath, sessionDir } };
  } catch (error) {
    console.warn('[discovery] failed to read', filePath, error);
    return undefined;
  }
}

export async function codexHeader(filePath: string, settings: Settings, now = Date.now()): Promise<{ run: RunSummary; location: RunLocation } | undefined> {
  try {
    const chunks = await readHeadTail(filePath);
    const text = chunks.tail ? `${chunks.head}\n${chunks.tail}` : chunks.head;
    const { run } = parseCodexSession({ filePath, text, mtimeMs: chunks.mtimeMs, now, activeWindowMs: activeWindowMs(settings), isGitRoot, homeDir: homedir(), headerOnly: true });
    return { run, location: { id: run.id, provider: 'codex', filePath } };
  } catch (error) {
    console.warn('[discovery] failed to read', filePath, error);
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const entries = items.entries();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const next = entries.next();
      if (next.done) return;
      const [index, item] = next.value;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverAll(settings: Settings, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const now = Date.now();
  const runs: RunSummary[] = [];
  const locations = new Map<string, RunLocation>();
  const sources: DiscoverySource[] = [];

  // Claude Code: <projects>/<encoded-cwd>/<sessionId>.jsonl
  const claudeDir = settings.claudeSessionsDir;
  if (!existsSync(claudeDir)) {
    sources.push({ provider: 'claude', path: claudeDir, exists: false, sessionCount: 0 });
  } else {
    const projectDirs = (await listDir(claudeDir)).map((n) => join(claudeDir, n));
    const files: string[] = [];
    for (const dir of projectDirs) {
      if (!(await isDirectory(dir))) continue;
      for (const name of await listDir(dir)) if (name.endsWith('.jsonl')) files.push(join(dir, name));
    }
    const results = await mapLimit(files, 16, (f) => claudeHeader(f, settings, now, options));
    let count = 0;
    for (const result of results) {
      if (!result || (options.acceptRun && !options.acceptRun(result.run))) continue;
      runs.push(result.run);
      locations.set(result.location.id, result.location);
      count += 1;
    }
    sources.push({ provider: 'claude', path: claudeDir, exists: true, sessionCount: count });
  }

  // Codex: <sessions>/YYYY/MM/DD/rollout-*.jsonl
  const codexDir = settings.codexSessionsDir;
  if (!existsSync(codexDir)) {
    sources.push({ provider: 'codex', path: codexDir, exists: false, sessionCount: 0 });
  } else {
    const files = await walkJsonl(codexDir);
    const results = await mapLimit(files, 16, (f) => codexHeader(f, settings, now));
    let count = 0;
    for (const result of results) {
      if (!result || (options.acceptRun && !options.acceptRun(result.run))) continue;
      runs.push(result.run);
      locations.set(result.location.id, result.location);
      count += 1;
    }
    sources.push({ provider: 'codex', path: codexDir, exists: true, sessionCount: count });
  }

  return { runs, locations, sources };
}

/** Parse a run in full, including subagent transcripts. */
export async function loadRunDetail(location: RunLocation, settings: Settings, now = Date.now(), options: DiscoveryOptions = {}): Promise<RunDetail> {
  const window = activeWindowMs(settings);
  if (location.provider === 'codex') {
    const text = await readText(location.filePath);
    const { run, agents } = parseCodexSession({ filePath: location.filePath, text, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
    if (run.id !== location.id) throw new RunIdentityError();
    if (options.acceptRun && !options.acceptRun(run)) throw new RunScopeError();
    return { run, agents };
  }
  const sessionDir = location.sessionDir ?? location.filePath.slice(0, -'.jsonl'.length);
  const [mainText, subPaths] = await Promise.all([readText(location.filePath), listSubagentFiles(sessionDir)]);
  const sessionId = latestClaudeSessionId(mainText);
  if (sessionId !== undefined && sessionId !== location.id) throw new RunIdentityError();
  let acceptSubagent: ((cwd: string | undefined) => boolean) | undefined;
  const acceptRun = options.acceptRun;
  if (acceptRun) {
    const root = parseClaudeHeader({ sessionId: location.id, filePath: location.filePath, headText: mainText, tailText: '', mtimeMs: 0, subagentCount: 0, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
    if (!acceptRun(root)) throw new RunScopeError();
    acceptSubagent = (cwd) => {
      if (!cwd) return true; // No explicit directory: inherit the root session.
      const project = resolveProject(cwd, { isGitRoot, homeDir: homedir() });
      return acceptRun({ ...root, cwd, projectName: project.name, projectPath: project.path });
    };
  }
  const subagentFiles: SubagentFile[] = await Promise.all(
    subPaths.map(async (path) => {
      const agentId = basename(path, '.jsonl').replace(/^agent-/, '');
      const metaPath = path.replace(/\.jsonl$/, '.meta.json');
      const [text, metaText] = await Promise.all([readText(path), existsSync(metaPath) ? readText(metaPath) : Promise.resolve(undefined)]);
      return { agentId, text, meta: parseSubagentMeta(metaText) };
    }),
  );
  const detail = parseClaudeSession({ sessionId: location.id, filePath: location.filePath, mainText, subagentFiles, now, activeWindowMs: window, isGitRoot, homeDir: homedir(), ...(acceptSubagent ? { acceptSubagent } : {}) });
  if (acceptRun && !acceptRun(detail.run)) throw new RunScopeError();
  return detail;
}
