import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { QueryError, SessionReader, pathWithin } from '../src/cli/service';
import type { Settings } from '../src/shared/types';

let root: string;
let project: string;
let otherProject: string;
let settings: Settings;
const PRIVATE = 'SECRET_TRANSCRIPT_MARKER';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentlens-reader-'));
  project = join(root, 'app');
  otherProject = join(root, 'app-other');
  await Promise.all([mkdir(join(project, '.git'), { recursive: true }), mkdir(join(otherProject, '.git'), { recursive: true })]);
  settings = {
    claudeSessionsDir: join(root, 'claude-projects'), codexSessionsDir: join(root, 'codex-sessions'),
    theme: 'system', notifications: false, activeWindowSeconds: 45, pricing: {}, claudeBinary: '', allowPrMerge: false,
  };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function reader(options: { allProjects?: boolean; allowText?: boolean } = {}): SessionReader {
  return new SessionReader({ settings, project, ...options });
}

async function save(path: string, records: object[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function claude(id: string, cwd = project, options: { at?: number; path?: string; edits?: number; pending?: boolean } = {}): Promise<string> {
  const at = options.at ?? Date.now() - 10_000;
  const common = { sessionId: id, cwd, isSidechain: false };
  const timestamp = (offset: number) => new Date(at + offset).toISOString();
  const path = options.path ?? join(settings.claudeSessionsDir, 'synthetic', `${id}.jsonl`);
  const records: object[] = [
    { ...common, type: 'user', uuid: `${id}-u1`, timestamp: timestamp(0), message: { role: 'user', content: `${PRIVATE} prompt` } },
    { ...common, type: 'assistant', uuid: `${id}-a1`, timestamp: timestamp(1), message: {
      id: `${id}-m1`, role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: `${id}-bash`, name: 'Bash', input: { command: `${PRIVATE} command` } }],
    } },
  ];
  if (!options.pending) {
    records.push({ ...common, type: 'user', uuid: `${id}-u2`, timestamp: timestamp(2), message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-bash`, is_error: true, content: `${PRIVATE} result` }],
    } });
  }
  for (let i = 0; i < (options.edits ?? 0); i += 1) {
    records.push({ ...common, type: 'assistant', uuid: `${id}-edit-${i}`, timestamp: timestamp(3 + i * 2), message: {
      id: `${id}-edit-msg-${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `edit-${i}`, name: 'Edit', input: {
        file_path: join(cwd, `file-${i}.ts`), old_string: 'a', new_string: 'b',
      } }],
    } });
    records.push({ ...common, type: 'user', uuid: `${id}-edit-result-${i}`, timestamp: timestamp(4 + i * 2), message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: `edit-${i}`, content: 'ok' }],
    } });
  }
  if (!options.pending) records.push({ ...common, type: 'assistant', uuid: `${id}-a2`, timestamp: timestamp(100), message: {
    id: `${id}-m2`, role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: `${PRIVATE} answer ${'x'.repeat(1000)}` }],
  } });
  await save(path, records);
  await utimes(path, new Date(at), new Date(at + 100));
  return path;
}

async function codex(id: string, cwd = project): Promise<void> {
  const at = Date.now() - 1000;
  const timestamp = new Date(at).toISOString();
  await save(join(settings.codexSessionsDir, '2026', '10', '22', `rollout-${id}.jsonl`), [
    { type: 'session_meta', timestamp, payload: { id, cwd, timestamp } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `${PRIVATE} codex prompt` } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
    { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: `${id}-call`, arguments: JSON.stringify({ cmd: `${PRIVATE} codex command` }) } },
    { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: `${id}-call`, output: `Process exited with code 1\n${PRIVATE} codex result` } },
  ]);
}

describe('SessionReader project scope', () => {
  it('includes descendant working directories and excludes sibling prefix matches', async () => {
    const child = join(project, 'src');
    await mkdir(child);
    await Promise.all([claude('inside'), claude('descendant', child), claude('outside', otherProject), codex('codex-inside')]);
    const result = await reader().listRuns();
    expect(result.runs.map((run) => run.id).sort()).toEqual(['codex-inside', 'descendant', 'inside']);
    expect(result.total).toBe(3);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(result.runs.every((run) => !('title' in run))).toBe(true);
  });

  it('checks canonical paths and rejects a symlink pointing outside the project', async () => {
    const link = join(project, 'outside');
    await symlink(otherProject, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(pathWithin(realpathSync(project), project)).toBe(true);
    expect(pathWithin(realpathSync(project), otherProject)).toBe(false);
    expect(pathWithin(realpathSync(project), link)).toBe(false);
    // Historical logs may reference a deleted directory beneath that symlink.
    expect(pathWithin(realpathSync(project), join(link, 'deleted-workdir'))).toBe(false);
    expect(pathWithin(realpathSync(project), '../app-other')).toBe(false);
  });

  it('only exposes other projects after a server startup opt-in', async () => {
    await Promise.all([claude('inside'), claude('outside', otherProject)]);
    expect((await reader().listRuns()).total).toBe(1);
    const global = await reader({ allProjects: true }).listRuns();
    expect(global.total).toBe(2);
    expect(global.project).toBeNull();
  });

  it('rejects unknown IDs, file paths, and IDs from other projects', async () => {
    const path = await claude('outside', otherProject);
    await claude('inside');
    const service = reader();
    for (const id of ['outside', '../outside', path, 'unknown', '', 'a'.repeat(301)]) {
      await expect(service.inspectRun(id)).rejects.toBeInstanceOf(QueryError);
      await expect(service.diagnoseRun(id)).rejects.toBeInstanceOf(QueryError);
    }
  });

  it.each(['claude', 'codex'] as const)('preserves the scope error when %s metadata changes during the index cache window', async (provider) => {
    const write = provider === 'claude' ? claude : codex;
    await write('moving');
    const service = reader();
    expect((await service.listRuns()).total).toBe(1);
    await write('moving', otherProject);
    await expect(service.inspectRun('moving')).rejects.toThrow(new QueryError('Run is no longer in the configured project'));
    await expect(service.diagnoseRun('moving')).rejects.toThrow(new QueryError('Run is no longer in the configured project'));
  });

  it('filters independent Codex rollouts by their own project metadata', async () => {
    await Promise.all([codex('inside-a'), codex('inside-b', project), codex('outside', otherProject)]);
    const service = reader();
    expect((await service.listRuns()).runs.map((run) => run.id).sort()).toEqual(['inside-a', 'inside-b']);
    expect((await service.inspectRun('inside-a')).totalAgents).toBe(1);
    expect((await service.inspectRun('inside-b')).totalAgents).toBe(1);
    await expect(service.inspectRun('outside')).rejects.toThrow('Run not found in the configured project');
  });

  it('excludes Claude subagents with an explicit out-of-scope working directory', async () => {
    const mainPath = await claude('parent');
    const subdir = join(mainPath.slice(0, -6), 'subagents');
    await Promise.all([
      claude('child-inside', project, { path: join(subdir, 'agent-child-inside.jsonl') }),
      claude('child-outside', otherProject, { path: join(subdir, 'agent-child-outside.jsonl') }),
    ]);
    const service = reader();
    expect((await service.listRuns()).runs[0]?.agentCount).toBe(2);
    const result = await service.inspectRun('parent');
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(['child-inside', 'parent']);
  });

  it('filters legacy Claude sidechains and lets children without cwd inherit the root scope', async () => {
    const mainPath = await claude('legacy');
    await appendFile(mainPath, JSON.stringify({ type: 'user', isSidechain: true, sessionId: 'different-sidechain-id', agentId: 'outside', uuid: 'outside-record', cwd: otherProject,
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'OUTSIDE_CHILD_TEXT' } }) + '\n');
    await save(join(mainPath.slice(0, -6), 'subagents', 'agent-inherited.jsonl'), [
      { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'inherited task' } },
    ]);
    const result = await reader({ allowText: true }).inspectRun('legacy', { includeText: true });
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(['inherited', 'legacy']);
    expect(JSON.stringify(result)).not.toContain('OUTSIDE_CHILD_TEXT');
  });

  it('keeps file-read failures distinct from changed project scope', async () => {
    const path = await claude('removed');
    const service = reader();
    await service.listRuns();
    await rm(path);
    await expect(service.inspectRun('removed')).rejects.toThrow(new QueryError('Could not read this run. Its session files may have moved or been removed.'));
  });

  it.each(['claude', 'codex'] as const)('preserves the typed identity error when a cached %s file is replaced', async (provider) => {
    const write = provider === 'claude' ? claude : codex;
    await write('old-id');
    const service = reader();
    await service.listRuns();
    if (provider === 'claude') {
      await save(join(settings.claudeSessionsDir, 'synthetic', 'old-id.jsonl'), [
        { type: 'user', sessionId: 'new-id', cwd: project, message: { role: 'user', content: 'replacement session' } },
      ]);
    } else {
      await save(join(settings.codexSessionsDir, '2026', '10', '22', 'rollout-old-id.jsonl'), [
        { type: 'session_meta', payload: { id: 'new-id', cwd: project } },
      ]);
    }
    await expect(service.inspectRun('old-id')).rejects.toThrow(new QueryError('Run identity changed. List runs again to refresh the available IDs.'));
  });

  it('requires the configured project to be an existing directory', async () => {
    expect(() => new SessionReader({ settings, project: join(root, 'missing') })).toThrow(QueryError);
    const file = join(root, 'plain-file');
    await writeFile(file, 'test');
    expect(() => new SessionReader({ settings, project: file })).toThrow(QueryError);
  });
});

describe('SessionReader bounded queries', () => {
  it('paginates deterministic run lists and filters providers/statuses', async () => {
    const at = Date.now() - 60_000;
    await Promise.all(Array.from({ length: 4 }, (_, index) => claude(`run-${index}`, project, { at: at + index * 1000 })));
    await codex('codex-run');
    const service = reader();
    const first = await service.listRuns({ provider: 'claude', limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual(['run-3', 'run-2']);
    expect(first.nextOffset).toBe(2);
    const second = await service.listRuns({ provider: 'claude', limit: 2, offset: 2 });
    expect(second.runs.map((run) => run.id)).toEqual(['run-1', 'run-0']);
    expect(second.nextOffset).toBeNull();
    expect((await service.listRuns({ provider: 'codex' })).total).toBe(1);
    expect((await service.listRuns({ status: 'running' })).runs.every((run) => run.status === 'running')).toBe(true);
    expect((await service.listRuns({ offset: 100 })).runs).toEqual([]);
  });

  it('paginates agents and limits file paths and text excerpts', async () => {
    const mainPath = await claude('many-agents', project, { edits: 15 });
    for (let index = 0; index < 3; index += 1) {
      await claude(`child-${index}`, project, { path: join(mainPath.slice(0, -6), 'subagents', `agent-child-${index}.jsonl`) });
    }
    const service = reader({ allowText: true });
    const first = await service.inspectRun('many-agents', { limit: 2, includeText: true });
    expect(first.totalAgents).toBe(4);
    expect(first.nextOffset).toBe(2);
    const main = first.agents.find((agent) => agent.role === 'main');
    expect(main?.filesTouchedCount).toBe(15);
    expect(main?.filesTouched).toHaveLength(10);
    expect(main?.lastAssistantText?.length).toBeLessThanOrEqual(601);
    const second = await service.inspectRun('many-agents', { limit: 2, offset: 2 });
    expect(second.agents).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
  });

  it('keeps prompts, commands, tool outputs, and assistant text out of default responses', async () => {
    await Promise.all([claude('private-claude'), codex('private-codex')]);
    const service = reader();
    for (const id of ['private-claude', 'private-codex']) {
      const inspected = await service.inspectRun(id);
      const diagnostics = await service.diagnoseRun(id);
      expect(inspected.run.tokensLoaded).toBe(true);
      expect(JSON.stringify({ inspected, diagnostics })).not.toContain(PRIVATE);
      expect(inspected.agents.every((agent) => !('currentAction' in agent) && !('title' in agent))).toBe(true);
    }
  });

  it('does not expose malformed non-scalar metadata through typed parser fields', async () => {
    const mainPath = await claude('malformed');
    await appendFile(mainPath, JSON.stringify({ type: 'assistant', uuid: 'malformed-metadata', cwd: project, timestamp: new Date().toISOString(), message: {
      id: 'malformed-usage', role: 'assistant', model: { unexpected: PRIVATE }, usage: { input_tokens: PRIVATE, output_tokens: -100 }, content: [],
    } }) + '\n');
    const subdir = join(mainPath.slice(0, -6), 'subagents');
    await claude('malformed-child', project, { path: join(subdir, 'agent-malformed-child.jsonl') });
    await writeFile(join(subdir, 'agent-malformed-child.meta.json'), JSON.stringify({ spawnDepth: { unexpected: PRIVATE } }));
    const service = reader();
    const listed = await service.listRuns();
    const inspected = await service.inspectRun('malformed');
    expect(JSON.stringify({ listed, inspected })).not.toContain(PRIVATE);
    expect(inspected.agents.every((agent) => Number.isInteger(agent.depth))).toBe(true);
    expect(inspected.run.tokens?.input).toBe(0);
    expect(inspected.agents.every((agent) => Object.values(agent.tokens).every((count) => typeof count === 'number' && count >= 0))).toBe(true);
  });

  it('requires both startup permission and a per-call request to include excerpts', async () => {
    await claude('private');
    const restricted = reader();
    await expect(restricted.listRuns({ includeText: true })).rejects.toThrow('--include-text');
    await expect(restricted.inspectRun('private', { includeText: true })).rejects.toThrow('--include-text');
    const optedIn = reader({ allowText: true });
    expect(JSON.stringify(await optedIn.inspectRun('private'))).not.toContain(PRIVATE);
    expect(JSON.stringify(await optedIn.inspectRun('private', { includeText: true }))).toContain(PRIVATE);
    expect(JSON.stringify(await optedIn.listRuns({ includeText: true }))).toContain(PRIVATE);
  });

  it('rejects invalid paging and diagnostic limits', async () => {
    await claude('run');
    const service = reader();
    for (const limit of [0, -1, 1.5, 101, Infinity, NaN]) {
      await expect(service.listRuns({ limit })).rejects.toBeInstanceOf(QueryError);
      await expect(service.inspectRun('run', { limit })).rejects.toBeInstanceOf(QueryError);
      await expect(service.diagnoseRun('run', limit)).rejects.toBeInstanceOf(QueryError);
    }
    for (const offset of [-1, 0.5, 1_000_001]) await expect(service.listRuns({ offset })).rejects.toBeInstanceOf(QueryError);
  });

  it('explains missing provider directories without exposing transcripts', async () => {
    const result = await reader().doctor();
    expect(result.readOnly).toBe(true);
    expect(result.transcriptTextEnabled).toBe(false);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => !source.exists && source.runsInScope === 0 && source.hint?.includes('-dir'))).toBe(true);
  });
});
