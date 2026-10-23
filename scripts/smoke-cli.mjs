import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(root, 'dist-cli/index.cjs');
const temp = await fs.mkdtemp(join(tmpdir(), 'agentlens-stdio-'));
const cli = join(temp, 'agentlens.cjs');
const project = join(temp, 'project with spaces');
const sessions = join(temp, 'claude', 'synthetic');
const scope = ['--project', project, '--claude-dir', join(temp, 'claude'), '--codex-dir', join(temp, 'no-codex')];
let client;
try {
  // Run the distributable away from this checkout's node_modules. The compiled
  // CLI must need only Node, so SDK build dependencies stay out of desktop installs.
  await fs.copyFile(bundle, cli);
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  const subagents = join(sessions, 'smoke-run', 'subagents');
  await fs.mkdir(subagents, { recursive: true });
  const timestamp = new Date().toISOString();
  const writeSession = async (path, id, content) => {
    const records = [
      { type: 'user', uuid: `${id}-user`, timestamp, cwd: project, message: { role: 'user', content: `PRIVATE_SMOKE_PROMPT ${id}` } },
      { type: 'assistant', uuid: `${id}-assistant`, timestamp, cwd: project, message: { role: 'assistant', content, stop_reason: 'end_turn' } },
    ];
    await fs.writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  };
  await writeSession(join(sessions, 'smoke-run.jsonl'), 'smoke-run', [
    { type: 'tool_use', id: 'spawn-child', name: 'Agent', input: { description: 'Inspect a component', prompt: 'PRIVATE_SMOKE_PROMPT child' } },
  ]);
  await writeSession(join(subagents, 'agent-child.jsonl'), 'child', [
    { type: 'tool_use', id: 'spawn-grandchild', name: 'Agent', input: { description: 'Inspect a helper', prompt: 'PRIVATE_SMOKE_PROMPT grandchild' } },
  ]);
  await writeSession(join(subagents, 'agent-grandchild.jsonl'), 'grandchild', [{ type: 'text', text: 'PRIVATE_SMOKE_ANSWER' }]);
  await fs.writeFile(join(subagents, 'agent-child.meta.json'), JSON.stringify({ toolUseId: 'spawn-child', spawnDepth: 1 }));
  await fs.writeFile(join(subagents, 'agent-grandchild.meta.json'), JSON.stringify({ toolUseId: 'spawn-grandchild', spawnDepth: 2 }));
  const listed = await exec(process.execPath, [cli, 'list', ...scope], { timeout: 10000 });
  const list = JSON.parse(listed.stdout);
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].agentCount, 3);
  const runId = list.runs[0].id;
  const inspected = JSON.parse((await exec(process.execPath, [cli, 'inspect', runId, ...scope], { timeout: 10000 })).stdout);
  assert.equal(inspected.agents.length, 3);
  assert.deepEqual(inspected.agents.map((agent) => agent.depth).sort(), [0, 1, 2]);
  assert.equal(inspected.agents.find((agent) => agent.id === 'child').parentId, 'smoke-run');
  assert.equal(inspected.agents.find((agent) => agent.id === 'grandchild').parentId, 'child');
  assert.ok(!JSON.stringify({ list, inspected }).includes('PRIVATE_SMOKE'));
  assert.equal(inspected.textIncluded, false);
  const diagnostic = JSON.parse((await exec(process.execPath, [cli, 'diagnose', runId, ...scope], { timeout: 10000 })).stdout);
  assert.equal(diagnostic.counts.agents, 3);

  const errors = [];
  client = new Client({ name: 'agentlens-stdio-smoke', version: '1.0.0' });
  client.onerror = (error) => errors.push(error.message);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...scope], stderr: 'pipe' });
  await client.connect(transport);
  const advertised = await client.listTools();
  assert.equal(advertised.tools.length, 4);
  const result = await client.callTool({ name: 'agentlens_get_run', arguments: { runId } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.totalAgents, 3);
  assert.equal((await client.callTool({ name: 'agentlens_get_run', arguments: { runId, includeText: true } })).isError, true);
  assert.equal((await client.callTool({ name: 'agentlens_get_run', arguments: { runId: '../../outside' } })).isError, true);
  const findings = await client.callTool({ name: 'agentlens_diagnose', arguments: { runId } });
  assert.equal(findings.structuredContent.counts.agents, 3);
  await client.ping();
  assert.deepEqual(errors, [], 'stdout must contain only valid MCP messages');
  console.log(JSON.stringify({ cli: 'list/inspect/diagnose passed', mcp: 'spawned bundle initialize/list/call/ping passed', agents: 3, topologyDepths: [0, 1, 2], protocolErrors: errors.length, textOptIn: 'enforced', unknownId: 'rejected' }, null, 2));
} finally {
  await client?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
