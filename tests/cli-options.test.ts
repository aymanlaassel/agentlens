import { describe, expect, it } from 'vitest';
import { clientConfig, parseCliOptions } from '../src/cli/options';
import { defaultSettings } from '../src/main/default-settings';

describe('headless CLI options', () => {
  it('requires an explicit run ID for inspection and validates limits', () => {
    expect(() => parseCliOptions(['inspect'])).toThrow('requires a run ID');
    expect(() => parseCliOptions(['list', '--limit', '0'])).toThrow('limit');
    expect(() => parseCliOptions(['list', '--limit', '2.5'])).toThrow('limit');
    expect(() => parseCliOptions(['list', '--offset', '-1'])).toThrow('offset');
    expect(() => parseCliOptions(['mcp', '--idle-seconds', 'NaN'])).toThrow('idle-seconds');
    expect(() => parseCliOptions(['list', '--provider', 'other'])).toThrow('provider');
    expect(() => parseCliOptions(['list', '--provider', ''])).toThrow('provider');
    expect(() => parseCliOptions(['list', '--status', ''])).toThrow('status');
    expect(() => parseCliOptions(['list', '--status', 'unknown'])).toThrow('status');
    expect(() => parseCliOptions(['config', '--client', 'other'])).toThrow('client');
    expect(() => parseCliOptions(['config', '--client', ''])).toThrow('client');
    expect(() => parseCliOptions(['unknown'])).toThrow('Unknown command');
    expect(() => parseCliOptions(['mcp', '--typo'])).toThrow();
  });

  it('defaults to metadata within the current working directory', () => {
    const options = parseCliOptions(['list']);
    expect(options).toMatchObject({ project: process.cwd(), allProjects: false, includeText: false, limit: 20, offset: 0 });
    expect(parseCliOptions([]).command).toBe('help');
    expect(parseCliOptions(['--help']).command).toBe('help');
    expect(defaultSettings().allowPrMerge).toBe(false);
  });

  it('prints configuration with argv arrays instead of shell interpolation', () => {
    const options = parseCliOptions(['config', '--project', '/tmp/repo with spaces', '--include-text', '--claude-dir', '/tmp/custom claude', '--idle-seconds', '90']);
    const config = JSON.parse(clientConfig(options, '/tmp/app path/index.cjs', 'C:\\Program Files\\nodejs\\node.exe')) as { mcpServers: { agentlens: { command: string; args: string[] } } };
    expect(config.mcpServers.agentlens.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(config.mcpServers.agentlens.args).toContain(options.project);
    expect(config.mcpServers.agentlens.args).toContain('--include-text');
    expect(config.mcpServers.agentlens.args).toContain(options.claudeDir);
    expect(config.mcpServers.agentlens.args.slice(-2)).toEqual(['--idle-seconds', '90']);
    const toml = clientConfig({ ...options, client: 'codex' }, '/tmp/app path/index.cjs', 'C:\\Program Files\\nodejs\\node.exe');
    expect(toml).toContain('[mcp_servers.agentlens]');
    expect(toml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(toml).not.toContain('npm');
  });
});
