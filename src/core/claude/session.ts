import type { AgentDetail, AgentStatus, RunDetail, RunSummary, TimelineEvent, TodoItem, ToolCall } from '../../shared/types';
import { describeToolCall } from '../activity';
import { resolveProject } from '../project';
import { deriveStatus } from '../status';
import { allText, cleanUserText, isSystemNotice, titleFromPrompt, truncate } from '../text';
import { UsageAccumulator } from '../tokens';
import { contentBlocks, parseJsonl, resultText, timestampMs, type ClaudeRecord, type SubagentMeta } from './records';

export interface SubagentFile {
  agentId: string;
  text: string;
  meta?: SubagentMeta | undefined;
}

export interface ClaudeSessionInput {
  sessionId: string;
  filePath: string;
  mainText: string;
  subagentFiles?: SubagentFile[];
  /** Last modification time of the main file, used as a floor for lastActivityAt. */
  mtimeMs?: number;
  now: number;
  activeWindowMs: number;
  /** Optional boundary for subagents; a missing working directory inherits the root. */
  acceptSubagent?: (cwd: string | undefined) => boolean;
  isGitRoot?: (dir: string) => boolean;
  homeDir?: string;
}

interface SpawnInfo {
  toolUseId: string;
  description?: string;
  prompt?: string;
  agentType?: string;
  resolvedModel?: string;
  /** Agent id reported back in toolUseResult (async launches). */
  resolvedAgentId?: string;
  spawnerAgentId: string;
  at?: number;
  /** A non-launch result came back for this tool use, meaning a synchronous subagent finished. */
  completed: boolean;
  isError: boolean;
}

interface AgentGroup {
  id: string;
  role: 'main' | 'subagent';
  records: ClaudeRecord[];
  meta?: SubagentMeta;
}

interface BuiltAgent {
  agent: AgentDetail;
  spawns: SpawnInfo[];
  firstUserText: string;
  lastStopReason: string | undefined;
  lastWasApiError: boolean;
  lastToolResultError: boolean;
  pendingToolCall: boolean;
  assistantMessages: number;
  handedBack: boolean;
}

const PREVIEW_CHARS = 240;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function usageFrom(message: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }) {
  const u = message.usage;
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

function todosFrom(input: unknown): TodoItem[] | undefined {
  if (!isObject(input) || !Array.isArray(input.todos)) return undefined;
  const todos: TodoItem[] = [];
  for (const item of input.todos) {
    if (!isObject(item) || typeof item.content !== 'string') continue;
    const status = item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending';
    const todo: TodoItem = { content: item.content, status };
    if (typeof item.activeForm === 'string') todo.activeForm = item.activeForm;
    todos.push(todo);
  }
  return todos;
}

/** Group a session's records into the main agent and its subagents. */
function groupRecords(main: ClaudeRecord[], sessionId: string, subagentFiles: SubagentFile[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  const mainGroup: AgentGroup = { id: sessionId, role: 'main', records: [] };
  groups.set(sessionId, mainGroup);

  // Legacy format: subagent transcripts interleaved in the main file as "sidechain" records.
  const sidechain = main.filter((r) => r.isSidechain);
  const sidechainByUuid = new Map(sidechain.filter((r) => r.uuid).map((r) => [r.uuid as string, r]));
  const rootCache = new Map<string, string>();
  const rootOf = (record: ClaudeRecord): string => {
    const start = record.uuid ?? '';
    if (rootCache.has(start)) return rootCache.get(start) as string;
    let current = record;
    const visited = new Set<string>();
    while (current.parentUuid && sidechainByUuid.has(current.parentUuid) && !visited.has(current.parentUuid)) {
      visited.add(current.parentUuid);
      current = sidechainByUuid.get(current.parentUuid) as ClaudeRecord;
    }
    const root = current.uuid ?? start;
    rootCache.set(start, root);
    return root;
  };

  for (const record of main) {
    if (!record.isSidechain) {
      mainGroup.records.push(record);
      continue;
    }
    const id = record.agentId ?? `legacy-${rootOf(record)}`;
    const group = groups.get(id) ?? { id, role: 'subagent', records: [] };
    group.records.push(record);
    groups.set(id, group);
  }

  for (const file of subagentFiles) {
    const records = parseJsonl(file.text);
    const existing = groups.get(file.agentId);
    const group: AgentGroup = existing
      ? { ...existing, records: [...existing.records, ...records] }
      : { id: file.agentId, role: 'subagent', records };
    if (file.meta) group.meta = file.meta;
    groups.set(file.agentId, group);
  }

  return [...groups.values()];
}

function buildAgent(group: AgentGroup, runId: string, cwd: string | undefined): BuiltAgent {
  const usage = new UsageAccumulator();
  const usageByMessage = new Map<string, { model?: string; usage: NonNullable<ReturnType<typeof usageFrom>> }>();
  const toolCalls: ToolCall[] = [];
  const toolCallById = new Map<string, ToolCall>();
  const timeline: TimelineEvent[] = [];
  const spawns: SpawnInfo[] = [];
  const spawnByToolUse = new Map<string, SpawnInfo>();
  const files = new Set<string>();
  let todos: TodoItem[] = [];
  let firstUserText = '';
  let lastAssistantText: string | undefined;
  let startedAt: number | undefined;
  let lastActivityAt: number | undefined;
  let lastStopReason: string | undefined;
  let lastWasApiError = false;
  let lastToolResultError = false;
  let errorText: string | undefined;
  let modelFromRecords: string | undefined;
  let assistantMessages = 0;
  let handedBack = false;

  const touch = (at: number | undefined) => {
    if (at === undefined) return;
    if (startedAt === undefined || at < startedAt) startedAt = at;
    if (lastActivityAt === undefined || at > lastActivityAt) lastActivityAt = at;
  };

  for (const record of group.records) {
    const at = timestampMs(record);
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    touch(at);
    const message = record.message;
    const blocks = contentBlocks(message);

    if (record.type === 'user') {
      let sawToolResult = false;
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          sawToolResult = true;
          const call = toolCallById.get(block.tool_use_id);
          const text = resultText(block.content);
          if (call) {
            if (at !== undefined) call.endedAt = at;
            if (block.is_error) call.isError = true;
            if (text) call.resultPreview = truncate(text, PREVIEW_CHARS);
          }
          lastToolResultError = !!block.is_error;
          lastWasApiError = false;
          if (block.is_error) {
            errorText = truncate(text || 'Tool call failed', 160);
          }
          const spawn = spawnByToolUse.get(block.tool_use_id);
          if (spawn) {
            const result = record.toolUseResult;
            const status = isObject(result) ? result.status : undefined;
            if (isObject(result) && typeof result.agentId === 'string') spawn.resolvedAgentId = result.agentId;
            if (isObject(result) && typeof result.resolvedModel === 'string') spawn.resolvedModel = result.resolvedModel;
            if (status !== 'async_launched' && !/^Async agent launched/i.test(text)) spawn.completed = true;
            if (block.is_error) spawn.isError = true;
          }
          if (at !== undefined) {
            timeline.push({ at, kind: 'tool-result', text: call?.summary ?? 'Tool result', ...(call?.name ? { toolName: call.name } : {}), ...(block.is_error ? { isError: true } : {}) });
          }
        }
      }
      if (!sawToolResult && !record.isMeta) {
        const text = cleanUserText(allText(message?.content));
        if (text) {
          if (!firstUserText && !isSystemNotice(text)) firstUserText = text;
          lastToolResultError = false;
          lastWasApiError = false;
          if (at !== undefined) timeline.push({ at, kind: 'user', text: truncate(text, 140) });
        }
      }
      continue;
    }

    // assistant
    if (record.isApiErrorMessage) {
      lastWasApiError = true;
      errorText = truncate(allText(message?.content) || 'API error', 160);
      if (at !== undefined) timeline.push({ at, kind: 'error', text: errorText, isError: true });
      continue;
    }
    lastWasApiError = false;
    assistantMessages += 1;
    if (message?.model) modelFromRecords = message.model;
    if (message?.stop_reason) lastStopReason = message.stop_reason;
    const u = message ? usageFrom(message) : undefined;
    if (u && message) {
      const key = message.id ?? `${record.uuid}`;
      usageByMessage.set(key, { ...(message.model ? { model: message.model } : {}), usage: u });
    }
    for (const block of blocks) {
      if (block.type === 'text' && block.text?.trim()) {
        lastAssistantText = block.text.trim();
        if (at !== undefined) timeline.push({ at, kind: 'assistant', text: truncate(block.text, 140) });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        const described = describeToolCall(block.name, block.input, cwd);
        const call: ToolCall = { id: block.id, name: block.name, kind: described.kind, summary: described.summary };
        if (described.file) call.file = described.file;
        if (at !== undefined) call.startedAt = at;
        toolCalls.push(call);
        toolCallById.set(block.id, call);
        for (const f of described.writes) files.add(f);
        handedBack = block.name === 'SubagentHandback';
        const newTodos = block.name === 'TodoWrite' ? todosFrom(block.input) : undefined;
        if (newTodos) todos = newTodos;
        if (block.name === 'Agent' || block.name === 'Task') {
          const input = isObject(block.input) ? block.input : {};
          const spawn: SpawnInfo = {
            toolUseId: block.id,
            spawnerAgentId: group.id,
            completed: false,
            isError: false,
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
            ...(typeof input.subagent_type === 'string' ? { agentType: input.subagent_type } : {}),
            ...(at !== undefined ? { at } : {}),
          };
          spawns.push(spawn);
          spawnByToolUse.set(block.id, spawn);
          if (at !== undefined) timeline.push({ at, kind: 'spawn', text: spawn.description ?? 'Spawned a subagent', toolName: block.name });
        } else if (at !== undefined) {
          timeline.push({ at, kind: 'tool-call', text: described.summary, toolName: block.name });
        }
      }
    }
  }

  for (const entry of usageByMessage.values()) usage.add(entry.model, entry.usage);

  const lastCall = toolCalls[toolCalls.length - 1];
  const pendingToolCall = !!lastCall && lastCall.endedAt === undefined && lastStopReason === 'tool_use';
  const inProgress = todos.find((t) => t.status === 'in_progress');
  const resolvedModel = usage.primaryModel() ?? modelFromRecords;

  const agent: AgentDetail = {
    id: group.id,
    runId,
    provider: 'claude',
    role: group.role,
    depth: group.role === 'main' ? 0 : 1,
    title: '',
    status: 'idle',
    toolCallCount: toolCalls.length,
    tokens: usage.total(),
    usageByModel: usage.models(),
    filesTouched: [...files],
    toolCalls,
    timeline,
    todos,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(lastCall ? { currentAction: lastCall.summary } : {}),
    ...(inProgress ? { nowTodo: inProgress.activeForm ?? inProgress.content } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(firstUserText ? { firstMessage: firstUserText } : {}),
    ...(lastAssistantText ? { lastAssistantText: truncate(lastAssistantText, 400) } : {}),
  };

  return { agent, spawns, firstUserText, lastStopReason, lastWasApiError, lastToolResultError, pendingToolCall, assistantMessages, handedBack };
}

function statusFor(built: BuiltAgent, input: ClaudeSessionInput, spawn: SpawnInfo | undefined): AgentStatus {
  const isSub = built.agent.role === 'subagent';
  const endedTurn = built.lastStopReason === 'end_turn' && !built.pendingToolCall;
  const completed = isSub ? !!spawn?.completed || endedTurn || built.handedBack : false;
  const stale = built.agent.lastActivityAt !== undefined && input.now - built.agent.lastActivityAt > input.activeWindowMs;
  const errored = (built.lastWasApiError || (built.lastToolResultError && stale)) || !!spawn?.isError;
  return deriveStatus({
    now: input.now,
    activeWindowMs: input.activeWindowMs,
    completed,
    errored,
    pendingToolCall: built.pendingToolCall,
    ...(built.agent.lastActivityAt !== undefined ? { lastActivityAt: built.agent.lastActivityAt } : {}),
  });
}

/** Parse a complete Claude Code session (main transcript plus subagent transcripts) into a RunDetail. */
export function parseClaudeSession(input: ClaudeSessionInput): RunDetail {
  const mainRecords = parseJsonl(input.mainText);
  const groups = groupRecords(mainRecords, input.sessionId, input.subagentFiles ?? []).filter((group) => {
    if (group.role === 'main' || !input.acceptSubagent) return true;
    const cwd = group.records.map((record) => record.cwd ?? record.attachment?.snapshot?.workingDirectory).find((dir) => typeof dir === 'string' && dir.length > 0);
    return input.acceptSubagent(cwd);
  });

  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let aiTitle: string | undefined;
  let isGitRepo: boolean | undefined;
  for (const record of mainRecords) {
    if (!cwd && record.cwd) cwd = record.cwd;
    if (record.gitBranch) gitBranch = record.gitBranch;
    if (record.type === 'ai-title' && record.aiTitle) aiTitle = record.aiTitle;
    if (record.attachment?.type === 'environment' && record.attachment.snapshot) {
      isGitRepo = record.attachment.snapshot.isGitRepo;
      if (!cwd) cwd = record.attachment.snapshot.workingDirectory;
    }
  }

  const built = groups.map((group) => buildAgent(group, input.sessionId, cwd));
  const byId = new Map(built.map((b) => [b.agent.id, b]));

  // Index every spawn across all agents so nested subagents resolve their parent.
  const spawnByAgentId = new Map<string, SpawnInfo>();
  const spawnByToolUseId = new Map<string, SpawnInfo>();
  const spawnByPrompt = new Map<string, SpawnInfo>();
  for (const b of built) {
    for (const spawn of b.spawns) {
      spawnByToolUseId.set(spawn.toolUseId, spawn);
      if (spawn.resolvedAgentId) spawnByAgentId.set(spawn.resolvedAgentId, spawn);
      if (spawn.prompt) spawnByPrompt.set(cleanUserText(spawn.prompt), spawn);
    }
  }

  const groupMeta = new Map(groups.map((g) => [g.id, g.meta]));
  const agents: AgentDetail[] = [];
  const mainBuilt = byId.get(input.sessionId);

  for (const b of built) {
    const agent = b.agent;
    if (agent.role === 'main') {
      agent.title = aiTitle || titleFromPrompt(b.firstUserText) || (b.assistantMessages === 0 ? 'Empty session' : 'Untitled session');
      agent.status = statusFor(b, input, undefined);
      agents.push(agent);
      continue;
    }
    const meta = groupMeta.get(agent.id);
    const spawn =
      spawnByAgentId.get(agent.id) ??
      (meta?.toolUseId ? spawnByToolUseId.get(meta.toolUseId) : undefined) ??
      (b.firstUserText ? spawnByPrompt.get(b.firstUserText) : undefined);
    const prompt = spawn?.prompt ?? b.firstUserText;
    const description = meta?.description ?? spawn?.description;
    agent.title = description ? truncate(description, 80) : titleFromPrompt(prompt) || 'Subagent';
    if (prompt) {
      agent.prompt = prompt;
      agent.subtitle = truncate(cleanUserText(prompt), 120);
    }
    const agentType = meta?.agentType ?? spawn?.agentType;
    if (agentType) agent.agentType = agentType;
    if (!agent.model && spawn?.resolvedModel) agent.model = spawn.resolvedModel;
    if (spawn) {
      agent.spawnToolUseId = spawn.toolUseId;
      agent.parentId = spawn.spawnerAgentId;
    } else {
      agent.parentId = input.sessionId;
    }
    agent.depth = meta?.spawnDepth ?? (agent.parentId === input.sessionId ? 1 : 2);
    if (agent.startedAt === undefined && spawn?.at !== undefined) agent.startedAt = spawn.at;
    agent.status = statusFor(b, input, spawn);
    if (agent.status === 'finished' || agent.status === 'errored') {
      agent.endedAt = agent.lastActivityAt ?? agent.startedAt ?? input.now;
    }
    agents.push(agent);
  }

  const main = agents.find((a) => a.role === 'main');
  if (main && (main.status === 'finished' || main.status === 'errored') && main.lastActivityAt !== undefined) main.endedAt = main.lastActivityAt;

  let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let startedAt: number | undefined;
  let lastActivityAt = input.mtimeMs;
  let anyRunning = false;
  for (const agent of agents) {
    totalTokens = {
      input: totalTokens.input + agent.tokens.input,
      output: totalTokens.output + agent.tokens.output,
      cacheRead: totalTokens.cacheRead + agent.tokens.cacheRead,
      cacheWrite: totalTokens.cacheWrite + agent.tokens.cacheWrite,
    };
    if (agent.startedAt !== undefined && (startedAt === undefined || agent.startedAt < startedAt)) startedAt = agent.startedAt;
    if (agent.lastActivityAt !== undefined && (lastActivityAt === undefined || agent.lastActivityAt > lastActivityAt)) lastActivityAt = agent.lastActivityAt;
    if (agent.status === 'running') anyRunning = true;
  }

  const project = resolveProject(cwd, {
    ...(input.isGitRoot && isGitRepo !== false ? { isGitRoot: input.isGitRoot } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });

  const run: RunSummary = {
    id: input.sessionId,
    provider: 'claude',
    title: main?.title ?? mainBuilt?.agent.title ?? 'Untitled session',
    projectName: project.name,
    projectPath: project.path,
    cwd: cwd ?? '',
    filePath: input.filePath,
    status: anyRunning ? 'running' : (main?.status ?? 'idle'),
    agentCount: agents.length,
    tokens: totalTokens,
    tokensLoaded: true,
    isEmpty: (mainBuilt?.assistantMessages ?? 0) === 0 && agents.length === 1,
    ...(gitBranch ? { gitBranch } : {}),
    ...(main?.model ? { model: main.model } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  };

  return { run, agents };
}

export interface ClaudeHeaderInput {
  sessionId: string;
  filePath: string;
  /** First chunk of the file (a few hundred KB is plenty). */
  headText: string;
  /** Last chunk of the file, used for last activity, model, and error state. */
  tailText: string;
  mtimeMs: number;
  subagentCount: number;
  now: number;
  activeWindowMs: number;
  isGitRoot?: (dir: string) => boolean;
  homeDir?: string;
}

/** Cheap discovery pass: enough to list a run without parsing the whole transcript. */
export function parseClaudeHeader(input: ClaudeHeaderInput): RunSummary {
  const head = parseJsonl(input.headText);
  const tail = input.tailText ? parseJsonl(input.tailText) : [];
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let aiTitle: string | undefined;
  let firstUserText = '';
  let startedAt: number | undefined;
  let isGitRepo: boolean | undefined;
  for (const record of head) {
    if (!cwd && record.cwd) cwd = record.cwd;
    if (record.gitBranch) gitBranch = record.gitBranch;
    if (record.type === 'ai-title' && record.aiTitle) aiTitle = record.aiTitle;
    if (record.attachment?.type === 'environment' && record.attachment.snapshot) {
      isGitRepo = record.attachment.snapshot.isGitRepo;
      if (!cwd) cwd = record.attachment.snapshot.workingDirectory;
    }
    const at = timestampMs(record);
    if (at !== undefined && (startedAt === undefined || at < startedAt)) startedAt = at;
    if (!firstUserText && record.type === 'user' && !record.isSidechain && !record.isMeta) {
      const blocks = contentBlocks(record.message);
      if (!blocks.some((b) => b.type === 'tool_result')) {
        const text = cleanUserText(allText(record.message?.content));
        if (text && !isSystemNotice(text)) firstUserText = text;
      }
    }
  }
  let lastActivityAt = input.mtimeMs;
  let model: string | undefined;
  let lastAssistant: ClaudeRecord | undefined;
  let sawAssistant = head.some((r) => r.type === 'assistant');
  let pendingToolCall = false;
  for (const record of tail) {
    if (record.type === 'ai-title' && record.aiTitle) aiTitle = record.aiTitle;
    if (record.gitBranch) gitBranch = record.gitBranch;
    const at = timestampMs(record);
    if (at !== undefined && at > lastActivityAt) lastActivityAt = at;
    if (record.type === 'assistant' && !record.isSidechain) {
      lastAssistant = record;
      sawAssistant = true;
      if (record.message?.model) model = record.message.model;
      pendingToolCall = record.message?.stop_reason === 'tool_use';
    } else if (record.type === 'user' && !record.isSidechain) {
      if (contentBlocks(record.message).some((b) => b.type === 'tool_result')) pendingToolCall = false;
    }
  }
  if (!model) {
    for (const record of head) if (record.type === 'assistant' && record.message?.model) model = record.message.model;
  }
  const project = resolveProject(cwd, {
    ...(input.isGitRoot && isGitRepo !== false ? { isGitRoot: input.isGitRoot } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  const status = deriveStatus({
    now: input.now,
    lastActivityAt,
    activeWindowMs: input.activeWindowMs,
    completed: false,
    errored: !!lastAssistant?.isApiErrorMessage,
    pendingToolCall,
  });
  return {
    id: input.sessionId,
    provider: 'claude',
    title: aiTitle || titleFromPrompt(firstUserText) || (sawAssistant ? 'Untitled session' : 'Empty session'),
    projectName: project.name,
    projectPath: project.path,
    cwd: cwd ?? '',
    filePath: input.filePath,
    status,
    agentCount: 1 + input.subagentCount,
    tokensLoaded: false,
    isEmpty: !sawAssistant && input.subagentCount === 0,
    lastActivityAt,
    ...(gitBranch ? { gitBranch } : {}),
    ...(model ? { model } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}
