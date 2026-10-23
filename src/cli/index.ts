import { defaultSettings } from '../main/default-settings';
import { clientConfig, HELP, parseCliOptions } from './options';
import { QueryError, SessionReader } from './service';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === 'config') {
    const entryPath = process.argv[1];
    if (!entryPath) throw new QueryError('Could not determine the CLI entry path for this configuration');
    process.stdout.write(clientConfig(options, entryPath, process.execPath) + '\n');
    return;
  }
  const settings = defaultSettings();
  settings.activeWindowSeconds = options.idleSeconds;
  if (options.claudeDir) settings.claudeSessionsDir = options.claudeDir;
  if (options.codexDir) settings.codexSessionsDir = options.codexDir;
  const reader = new SessionReader({ settings, project: options.project, allProjects: options.allProjects, allowText: options.includeText });
  if (options.command === 'mcp') {
    const { serveMcp } = await import('./mcp');
    await serveMcp(reader);
    return;
  }
  const page = { limit: options.limit, offset: options.offset, includeText: options.includeText };
  let output: object;
  switch (options.command) {
    case 'list':
      output = await reader.listRuns({ ...page, ...(options.provider ? { provider: options.provider } : {}), ...(options.status ? { status: options.status } : {}) });
      break;
    case 'inspect':
      if (!options.runId) throw new QueryError('inspect requires a run ID from the list command');
      output = await reader.inspectRun(options.runId, page);
      break;
    case 'diagnose':
      if (!options.runId) throw new QueryError('diagnose requires a run ID from the list command');
      output = await reader.diagnoseRun(options.runId, options.limit);
      break;
    case 'doctor':
      output = await reader.doctor();
      break;
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

void main().catch((error: unknown) => {
  console.error(`AgentLens: ${error instanceof Error ? error.message : 'Unexpected error'}`);
  process.exitCode = 1;
});
