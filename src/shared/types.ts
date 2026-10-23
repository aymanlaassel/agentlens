/** Data model shared by the main process, preload bridge, and renderer. */

export type Provider = 'claude' | 'codex';
export type AgentStatus = 'running' | 'idle' | 'finished' | 'errored';
export type AgentRole = 'main' | 'subagent';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  /** Number of API responses attributed to this model. */
  calls: number;
}

export type ToolKind = 'edit' | 'read' | 'shell' | 'search' | 'delegate' | 'web' | 'plan' | 'other';

export interface ToolCall {
  id: string;
  name: string;
  kind: ToolKind;
  /** Human-readable description, e.g. "Editing src/App.tsx". */
  summary: string;
  /** Workspace-relative file path when the call targets a file. */
  file?: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  /** Short excerpt of the result, for the side panel. */
  resultPreview?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type TimelineKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'spawn' | 'error' | 'finish';

export interface TimelineEvent {
  at: number;
  kind: TimelineKind;
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface AgentSummary {
  id: string;
  runId: string;
  provider: Provider;
  role: AgentRole;
  parentId?: string;
  /** The parent's tool-use id that spawned this agent. */
  spawnToolUseId?: string;
  depth: number;
  /** Task title: Agent `description` for subagents, shortened first prompt for the main agent. */
  title: string;
  /** Truncated prompt for subagents. */
  subtitle?: string;
  /** Full prompt that was handed to a subagent. */
  prompt?: string;
  agentType?: string;
  status: AgentStatus;
  /** "Currently:" line built from the latest tool call. */
  currentAction?: string;
  /** In-progress todo item, when a todo list exists. */
  nowTodo?: string;
  model?: string;
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number;
  toolCallCount: number;
  tokens: TokenUsage;
  usageByModel: ModelUsage[];
  filesTouched: string[];
  error?: string;
}

export interface AgentDetail extends AgentSummary {
  toolCalls: ToolCall[];
  timeline: TimelineEvent[];
  todos: TodoItem[];
  /** First user message (main agent) or the prompt (subagent). */
  firstMessage?: string;
  /** Latest assistant text, for a quick read of what the agent last said. */
  lastAssistantText?: string;
}

export interface RunSummary {
  id: string;
  provider: Provider;
  title: string;
  projectName: string;
  projectPath: string;
  cwd: string;
  filePath: string;
  gitBranch?: string;
  model?: string;
  startedAt?: number;
  lastActivityAt?: number;
  status: AgentStatus;
  agentCount: number;
  /** Populated lazily once the run has been parsed in full. */
  tokens?: TokenUsage;
  tokensLoaded: boolean;
  /** No assistant turn was ever recorded (e.g. an aborted or scheduled-job shell). */
  isEmpty: boolean;
}

export interface ProjectGroup {
  name: string;
  path: string;
  runIds: string[];
  lastActivityAt?: number;
  runningCount: number;
}

export interface RunDetail {
  run: RunSummary;
  agents: AgentDetail[];
}

export interface DiscoverySource {
  provider: Provider;
  path: string;
  exists: boolean;
  sessionCount: number;
  error?: string;
}

export interface Snapshot {
  runs: RunSummary[];
  sources: DiscoverySource[];
  scannedAt: number;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Settings {
  claudeSessionsDir: string;
  codexSessionsDir: string;
  theme: ThemePreference;
  notifications: boolean;
  /** Seconds without log activity before a running agent is considered idle. */
  activeWindowSeconds: number;
  pricing: Record<string, ModelPricing>;
  /** Path to the Claude Code CLI used to run workflows. Empty means auto-detect. */
  claudeBinary: string;
  /** Lets the PR merger role run gh pr merge. Off by default. */
  allowPrMerge: boolean;
}

export interface AgentStatusChange {
  runId: string;
  agentId: string;
  title: string;
  projectName: string;
  from: AgentStatus;
  to: AgentStatus;
}

/* ---------- Orchestration ---------- */

/** What a role may do on the machine. Mapped to Claude Code permission flags. */
export type RolePermission = 'read-only' | 'edit' | 'full';

export interface RoleDefinition {
  id: string;
  name: string;
  /** One line shown in the UI. */
  description: string;
  /** Appended to the agent's system prompt. */
  systemPrompt: string;
  permission: RolePermission;
  /** Extra tool patterns to allow beyond the permission preset, e.g. "Bash(npm test:*)". */
  extraTools?: string[];
  model?: string;
  maxTurns?: number;
  /** True for the roles that ship with AgentLens. */
  builtIn?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** Roles run in this order; each one receives the previous step's output. */
  roleIds: string[];
  builtIn?: boolean;
}

export type StepStatus = 'pending' | 'running' | 'finished' | 'errored' | 'cancelled';
export type WorkflowStatus = 'running' | 'finished' | 'errored' | 'cancelled';

export interface WorkflowStep {
  id: string;
  roleId: string;
  /** Prompt handed to the agent (goal plus previous output). */
  prompt: string;
  status: StepStatus;
  /** Claude Code session id; equals the run id in the sidebar once the log exists. */
  sessionId: string;
  startedAt?: number;
  endedAt?: number;
  /** Final assistant text of the step. Handed to the next role. */
  output?: string;
  /** Latest assistant text while running, for the live card. */
  liveText?: string;
  /** Latest tool call summary while running. */
  currentAction?: string;
  error?: string;
  costUsd?: number;
  turns?: number;
}

export interface WorkflowRun {
  id: string;
  name: string;
  goal: string;
  cwd: string;
  templateId?: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** Chat that asked for this workflow, when started by the conductor. */
  chatId?: string;
}

export interface WorkflowStartRequest {
  goal: string;
  cwd: string;
  /** Either a template or an explicit role sequence. */
  templateId?: string;
  roleIds?: string[];
  name?: string;
  /** Chat that asked for this workflow, when started by the conductor. */
  chatId?: string;
}

export interface OrchestratorConfig {
  roles: RoleDefinition[];
  templates: WorkflowTemplate[];
  /** Resolved path of the Claude Code binary, or undefined when none was found. */
  claudeBinary?: string;
}

/* ---------- Chat (conductor) ---------- */

export type ChatMessageKind = 'user' | 'assistant' | 'event';
export type ChatStatus = 'idle' | 'thinking' | 'waiting-workflow';

export interface ChatToolCall {
  name: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  text: string;
  at: number;
  /** Assistant: tool calls made while producing this reply. */
  toolCalls?: ChatToolCall[];
  /** Assistant: still streaming. */
  pending?: boolean;
  /** Event: the workflow this message refers to. */
  workflowId?: string;
  costUsd?: number;
  error?: string;
}

export interface Chat {
  id: string;
  title: string;
  cwd: string;
  /** Conductor's Claude Code session id. Started with --session-id, continued with --resume. */
  sessionId: string;
  sessionStarted: boolean;
  status: ChatStatus;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatCreateRequest {
  cwd: string;
  title?: string;
}

export interface ChatSendRequest {
  chatId: string;
  text: string;
}
