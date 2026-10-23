import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/cli/mcp';
import { SessionReader } from '../src/cli/service';

let root: string;
let reader: SessionReader;
let server: ReturnType<typeof createMcpServer>;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentlens-mcp-'));
  const project = join(root, 'app');
  const sessions = join(root, 'sessions');
  await Promise.all([mkdir(project), mkdir(join(sessions, '2026', '10', '22'), { recursive: true })]);
  const timestamp = new Date().toISOString();
  await writeFile(join(sessions, '2026', '10', '22', 'rollout-mcp-run.jsonl'), [
    { type: 'session_meta', timestamp, payload: { id: 'mcp-run', cwd: project, timestamp } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'SECRET_MCP_PROMPT' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  reader = new SessionReader({ project, settings: {
    claudeSessionsDir: join(root, 'missing-claude'), codexSessionsDir: sessions,
    theme: 'system', notifications: false, activeWindowSeconds: 45, pricing: {}, claudeBinary: '', allowPrMerge: false,
  } });
  server = createMcpServer(reader);
  client = new Client({ name: 'agentlens-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

describe('AgentLens MCP protocol', () => {
  it('completes SDK initialization and advertises four bounded read-only tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'agentlens', version: '0.1.0' });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toContain('not proof of a hung process');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'agentlens_diagnose', 'agentlens_doctor', 'agentlens_get_run', 'agentlens_list_runs',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools.find((tool) => tool.name === 'agentlens_get_run')?.inputSchema.required).toContain('runId');
    expect(await client.ping()).toEqual({});
  });

  it('lists and inspects a real synthetic session over MCP without exposing prompt text', async () => {
    const listed = await call('agentlens_list_runs', { provider: 'codex', limit: 1 });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({ total: 1, textIncluded: false, runs: [{ id: 'mcp-run', provider: 'codex' }] });
    const inspected = await call('agentlens_get_run', { runId: 'mcp-run' });
    expect(inspected.structuredContent).toMatchObject({ totalAgents: 1, textIncluded: false, agents: [{ id: 'mcp-run' }] });
    const diagnosed = await call('agentlens_diagnose', { runId: 'mcp-run', maxFindings: 1 });
    expect(diagnosed.structuredContent).toMatchObject({ runId: 'mcp-run', counts: { agents: 1 } });
    expect(JSON.stringify({ listed, inspected, diagnosed })).not.toContain('SECRET_MCP_PROMPT');
    const content = inspected.content[0];
    expect(content?.type).toBe('text');
    if (content?.type === 'text') expect(JSON.parse(content.text)).toEqual(inspected.structuredContent);
  });

  it('returns useful doctor output and handles unknown run IDs as tool errors', async () => {
    expect((await call('agentlens_doctor')).structuredContent).toMatchObject({ readOnly: true, transcriptTextEnabled: false });
    for (const id of ['unknown', '../outside', join(root, 'sessions', 'rollout-mcp-run.jsonl')]) {
      const result = await call('agentlens_get_run', { runId: id });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it('rejects invalid schemas through the SDK before they reach the reader', async () => {
    const inspect = vi.spyOn(reader, 'inspectRun');
    for (const args of [{}, { runId: 1 }, { runId: '' }, { runId: 'x'.repeat(301) }, { runId: 'mcp-run', limit: 101 }]) {
      const result = await call('agentlens_get_run', args);
      expect(result.isError).toBe(true);
    }
    expect(inspect).not.toHaveBeenCalled();
    for (const args of [{ provider: 'unknown' }, { status: 'unknown' }, { limit: 0 }, { offset: -1 }, { includeText: 'yes' }]) {
      expect((await call('agentlens_list_runs', args)).isError).toBe(true);
    }
    expect((await call('agentlens_diagnose', { runId: 'mcp-run', maxFindings: 1000 })).isError).toBe(true);
  });

  it('refuses transcript escalation from a tool argument without startup opt-in', async () => {
    const result = await call('agentlens_get_run', { runId: 'mcp-run', includeText: true, allowText: true, allProjects: true });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('--include-text');
    expect(JSON.stringify(result)).not.toContain('SECRET_MCP_PROMPT');
  });

  it('returns tool errors for unknown tools and hides unexpected internal error details', async () => {
    expect((await call('agentlens_run_shell', { command: 'echo test' })).isError).toBe(true);
    vi.spyOn(reader, 'doctor').mockRejectedValue(new Error('SECRET_INTERNAL_PATH'));
    const result = await call('agentlens_doctor');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET_INTERNAL_PATH');
    expect(JSON.stringify(result)).toContain('Unable to read local sessions');
  });
});
