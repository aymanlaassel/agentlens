import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentStatus, Provider } from '../shared/types';
import { QueryError } from './service';

const COMMANDS = ['help', 'list', 'inspect', 'diagnose', 'doctor', 'mcp', 'config'] as const;
export type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return COMMANDS.some((command) => command === value);
}

function isStatus(value: string): value is AgentStatus {
  return value === 'running' || value === 'idle' || value === 'finished' || value === 'errored';
}

export interface CliOptions {
  command: Command;
  project: string;
  allProjects: boolean;
  includeText: boolean;
  limit: number;
  offset: number;
  idleSeconds: number;
  runId?: string;
  claudeDir?: string;
  codexDir?: string;
  provider?: Provider;
  status?: AgentStatus;
  client: 'claude' | 'codex';
}

function numberOption(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new QueryError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      project: { type: 'string' },
      'all-projects': { type: 'boolean' },
      'include-text': { type: 'boolean' },
      'claude-dir': { type: 'string' },
      'codex-dir': { type: 'string' },
      'idle-seconds': { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      provider: { type: 'string' },
      status: { type: 'string' },
      client: { type: 'string' },
    },
  });
  const command = values.help ? 'help' : positionals[0] ?? 'help';
  if (!isCommand(command)) throw new QueryError(`Unknown command "${command}". Run agentlens --help.`);
  if (positionals.length > (command === 'inspect' || command === 'diagnose' ? 2 : 1)) throw new QueryError('Unexpected positional argument. Run agentlens --help.');
  const runId = positionals[1];
  if ((command === 'inspect' || command === 'diagnose') && !runId) throw new QueryError(`${command} requires a run ID from the list command`);
  const provider = values.provider;
  const status = values.status;
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') throw new QueryError('provider must be claude or codex');
  if (status !== undefined && !isStatus(status)) throw new QueryError('status must be running, idle, finished, or errored');
  if (values.client !== undefined && values.client !== 'claude' && values.client !== 'codex') throw new QueryError('client must be claude or codex');
  return {
    command,
    project: resolve(values.project ?? process.cwd()),
    allProjects: values['all-projects'] ?? false,
    includeText: values['include-text'] ?? false,
    limit: numberOption(values.limit, 20, 'limit', 1, 100),
    offset: numberOption(values.offset, 0, 'offset', 0, 1_000_000),
    idleSeconds: numberOption(values['idle-seconds'], 45, 'idle-seconds', 5, 3600),
    client: values.client === 'codex' ? 'codex' : 'claude',
    ...(runId ? { runId } : {}),
    ...(values['claude-dir'] ? { claudeDir: resolve(values['claude-dir']) } : {}),
    ...(values['codex-dir'] ? { codexDir: resolve(values['codex-dir']) } : {}),
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
  };
}

/** Print a reviewable configuration snippet; never rewrite the user's config. */
export function clientConfig(options: CliOptions, entryPath: string, nodePath: string): string {
  const args = [resolve(entryPath), 'mcp', '--project', options.project];
  if (options.allProjects) args.push('--all-projects');
  if (options.includeText) args.push('--include-text');
  if (options.claudeDir) args.push('--claude-dir', options.claudeDir);
  if (options.codexDir) args.push('--codex-dir', options.codexDir);
  if (options.idleSeconds !== 45) args.push('--idle-seconds', String(options.idleSeconds));
  if (options.client === 'claude') return JSON.stringify({ mcpServers: { agentlens: { type: 'stdio', command: nodePath, args } } }, null, 2);
  // JSON's quoted strings/arrays are also TOML basic strings/arrays. This preserves
  // spaces, quotes, and Windows backslashes without constructing shell commands.
  return `[mcp_servers.agentlens]\ncommand = ${JSON.stringify(nodePath)}\nargs = ${JSON.stringify(args)}`;
}

export const HELP = `AgentLens — local, read-only agent observability (Node.js 22+)

Usage: agentlens <command> [options]

Commands:
  list                 List recent runs as JSON (no full transcript parse)
  inspect <run-id>     Inspect a run's agent tree, timing, tools, and tokens
  diagnose <run-id>    Report failed tools and bounded diagnostic findings
  doctor              Check session discovery and project scope
  mcp                 Start the stdio MCP server (stdout is JSON-RPC only)
  config              Print a Claude JSON or Codex TOML configuration snippet

Options:
  --project <dir>     Scope to a project directory (default: current directory)
  --all-projects      Explicitly allow sessions from every local project
  --claude-dir <dir>  Override Claude's projects directory
  --codex-dir <dir>   Override Codex's sessions directory
  --provider <name>   Filter list: claude or codex
  --status <status>   Filter list: running, idle, finished, errored
  --limit <1-100>     List/agent page size; diagnostic finding cap (default: 20)
  --offset <number>   List/agent page offset (default: 0)
  --idle-seconds <n>  Silence threshold, 5–3600 (default: 45)
  --include-text     Opt into bounded session excerpts; MCP calls still opt in
  --client <name>    Config format: claude (default) or codex
  -h, --help          Show this help

The CLI does not persist results or modify sessions. MCP results
are shared with the connected harness and may be sent to its model provider.
Query available Claude Code and Codex runs through the shared local parsers.
Run the MCP server with direct node, not npm run (which writes banners).
`;
