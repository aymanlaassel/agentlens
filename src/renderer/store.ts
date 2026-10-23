import { create } from 'zustand';
import { DEFAULT_PRICING } from '../core/pricing';
import type { AgentStatus, Chat, OrchestratorConfig, Provider, RunDetail, RunSummary, Settings, Snapshot, WorkflowRun } from '../shared/types';

export type StatusFilter = 'all' | AgentStatus;
export type ProviderFilter = 'all' | Provider;
export type View = 'topology' | 'timeline';

export interface UiState {
  snapshot: Snapshot | undefined;
  snapshotError: string | undefined;
  loading: boolean;
  selectedRunId: string | undefined;
  selectedAgentId: string | undefined;
  details: Record<string, RunDetail>;
  detailLoading: boolean;
  search: string;
  projectFilter: string | 'all';
  statusFilter: StatusFilter;
  providerFilter: ProviderFilter;
  activeOnly: boolean;
  showEmpty: boolean;
  collapsedProjects: Record<string, boolean>;
  view: View;
  settings: Settings;
  settingsOpen: boolean;
  helpOpen: boolean;
  sidebarCollapsed: boolean;
  now: number;
  workflows: WorkflowRun[];
  orchestrator: OrchestratorConfig | undefined;
  selectedWorkflowId: string | undefined;
  workflowDialogOpen: boolean;
  chats: Chat[];
  selectedChatId: string | undefined;
  chatDialogOpen: boolean;
}

export interface UiActions {
  setSnapshot(snapshot: Snapshot): void;
  setSnapshotError(error: string | undefined): void;
  setLoading(loading: boolean): void;
  selectRun(runId: string | undefined): void;
  selectAgent(agentId: string | undefined): void;
  setDetail(detail: RunDetail): void;
  setDetailLoading(loading: boolean): void;
  mergeRun(run: RunSummary): void;
  setSearch(search: string): void;
  setProjectFilter(project: string | 'all'): void;
  setStatusFilter(status: StatusFilter): void;
  setProviderFilter(provider: ProviderFilter): void;
  toggleActiveOnly(): void;
  toggleShowEmpty(): void;
  toggleProject(name: string): void;
  setView(view: View): void;
  setSettings(settings: Settings): void;
  setSettingsOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
  toggleSidebar(): void;
  tickNow(): void;
  setWorkflows(workflows: WorkflowRun[]): void;
  upsertWorkflow(workflow: WorkflowRun): void;
  removeWorkflow(id: string): void;
  setOrchestratorConfig(config: OrchestratorConfig): void;
  selectWorkflow(id: string | undefined): void;
  setWorkflowDialogOpen(open: boolean): void;
  setChats(chats: Chat[]): void;
  upsertChat(chat: Chat): void;
  removeChat(id: string): void;
  selectChat(id: string | undefined): void;
  setChatDialogOpen(open: boolean): void;
}

export const DEFAULT_SETTINGS: Settings = {
  claudeSessionsDir: '~/.claude/projects',
  codexSessionsDir: '~/.codex/sessions',
  theme: 'system',
  notifications: false,
  activeWindowSeconds: 45,
  pricing: { ...DEFAULT_PRICING },
  claudeBinary: '',
  allowPrMerge: false,
};

export const useStore = create<UiState & UiActions>((set) => ({
  snapshot: undefined,
  snapshotError: undefined,
  loading: true,
  selectedRunId: undefined,
  selectedAgentId: undefined,
  details: {},
  detailLoading: false,
  search: '',
  projectFilter: 'all',
  statusFilter: 'all',
  providerFilter: 'all',
  activeOnly: false,
  showEmpty: false,
  collapsedProjects: {},
  view: 'topology',
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  helpOpen: false,
  sidebarCollapsed: false,
  now: Date.now(),
  workflows: [],
  orchestrator: undefined,
  selectedWorkflowId: undefined,
  workflowDialogOpen: false,
  chats: [],
  selectedChatId: undefined,
  chatDialogOpen: false,

  setSnapshot: (snapshot) => set({ snapshot, loading: false, snapshotError: undefined }),
  setSnapshotError: (snapshotError) => set({ snapshotError, loading: false }),
  setLoading: (loading) => set({ loading }),
  selectRun: (selectedRunId) => set({ selectedRunId, selectedAgentId: undefined, selectedWorkflowId: undefined, selectedChatId: undefined }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  setDetail: (detail) => set((state) => ({ details: { ...state.details, [detail.run.id]: detail }, detailLoading: false })),
  setDetailLoading: (detailLoading) => set({ detailLoading }),
  mergeRun: (run) =>
    set((state) => {
      if (!state.snapshot) return {};
      return { snapshot: { ...state.snapshot, runs: state.snapshot.runs.map((r) => (r.id === run.id ? run : r)) } };
    }),
  setSearch: (search) => set({ search }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setProviderFilter: (providerFilter) => set({ providerFilter }),
  toggleActiveOnly: () => set((s) => ({ activeOnly: !s.activeOnly })),
  toggleShowEmpty: () => set((s) => ({ showEmpty: !s.showEmpty })),
  toggleProject: (name) => set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [name]: !s.collapsedProjects[name] } })),
  setView: (view) => set({ view }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  tickNow: () => set({ now: Date.now() }),
  setWorkflows: (workflows) => set({ workflows: [...workflows].sort((a, b) => b.createdAt - a.createdAt) }),
  upsertWorkflow: (workflow) =>
    set((state) => {
      const exists = state.workflows.some((w) => w.id === workflow.id);
      const workflows = exists ? state.workflows.map((w) => (w.id === workflow.id ? workflow : w)) : [workflow, ...state.workflows];
      return { workflows: workflows.sort((a, b) => b.createdAt - a.createdAt) };
    }),
  removeWorkflow: (id) =>
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== id),
      selectedWorkflowId: state.selectedWorkflowId === id ? undefined : state.selectedWorkflowId,
    })),
  setOrchestratorConfig: (orchestrator) => set({ orchestrator }),
  selectWorkflow: (selectedWorkflowId) => set({ selectedWorkflowId, selectedRunId: undefined, selectedAgentId: undefined, selectedChatId: undefined }),
  setWorkflowDialogOpen: (workflowDialogOpen) => set({ workflowDialogOpen }),
  setChats: (chats) => set({ chats: [...chats].sort((a, b) => b.updatedAt - a.updatedAt) }),
  upsertChat: (chat) =>
    set((state) => {
      const exists = state.chats.some((c) => c.id === chat.id);
      const chats = exists ? state.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...state.chats];
      return { chats: chats.sort((a, b) => b.updatedAt - a.updatedAt) };
    }),
  removeChat: (id) =>
    set((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
      selectedChatId: state.selectedChatId === id ? undefined : state.selectedChatId,
    })),
  selectChat: (selectedChatId) => set({ selectedChatId, selectedRunId: undefined, selectedAgentId: undefined, selectedWorkflowId: undefined }),
  setChatDialogOpen: (chatDialogOpen) => set({ chatDialogOpen }),
}));
