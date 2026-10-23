# AgentLens

A local desktop dashboard that shows what your Claude Code and Codex agents are doing right now: which subagents the main agent spawned, what task each one was given, what it is working on this second, how long it has been running, and what it costs.

Session views come from the logs already on your disk. The optional CLI/MCP interface lets your own harness query those logs; see [Privacy](#privacy) for what can be shared.

![Topology view](docs/screenshots/topology.png)
*Topology: the main agent and its subagents, each card showing the task, status, and current action.*

## Why

Agent harnesses write detailed JSONL transcripts, but they are hard to read and say nothing about the overall shape of a run. AgentLens turns them into a live picture:

- **Real task descriptions.** Subagent cards show the `description` and prompt the parent gave them, not "Tool result".
- **A "Currently:" line in plain words.** "Editing src/App.tsx", "Running npm test", "Searching for 'auth'".
- **Projects, not launch folders.** Runs are grouped by the repository they worked in, with a title taken from your first prompt.
- **Parallelism you can see.** A Gantt timeline shows when each agent started and finished.

## Features

| Area | What you get |
| --- | --- |
| Sidebar | Runs grouped by project with run count and last-active time, search, filters by project/status/provider, an Active-only toggle, lazy token totals |
| Topology | Graph of agents with status colors and icons, animated edges only on running agents, auto-fit |
| Agent cards | Task title, status (Running / Idle / Finished / Errored), "Now:" item from the todo list, current action, elapsed time, tokens, tool count, model badge |
| Side panel | Task and full prompt, Timeline, Tool calls with result previews, Files touched, Token breakdown with per-model cost |
| Timeline | Horizontal Gantt of agent lifetimes with spawn markers and a now line |
| Chat | Talk to Claude about a project; a read-only Conductor answers questions itself and starts workflows when you ask for work to be done, then reports back |
| Workflows | Run role-based agent workflows (Planner → Coder → Reviewer, or your own roles) as headless Claude Code sessions, each visible in the sidebar like any other run |
| CLI / MCP | Read-only, project-scoped session queries for Claude Code, Codex, and other local stdio MCP clients; no Electron process needed |
| Diagnostics | Bounded findings for recorded failures, repeated failed tools, quiet pending calls, and potentially overlapping edits; heuristics are labeled |
| Settings | Session directories, light/dark/system theme, desktop notifications, idle window, editable per-model pricing, Claude Code CLI path, PR merge toggle |
| Keyboard | `/` search, `j`/`k` move, `Enter` open, `Esc` close, `1`/`2` views, `n` new workflow, `c` new chat, `?` help |

![Side panel](docs/screenshots/side-panel.png)
*Side panel on a subagent: the prompt it received, its tool calls, and token cost.*

![Timeline](docs/screenshots/timeline.png)
*Timeline: four subagents working in parallel while the main agent waits.*

## Install

Unsigned builds for macOS, Windows, and Linux are published on the [Releases](https://github.com/aymanlaassel/agentlens/releases) page. Because they are not code-signed, the OS will warn you on first launch:

- **macOS:** right-click the app → Open, then confirm. Or run `xattr -dr com.apple.quarantine /Applications/AgentLens.app`.
- **Windows:** in the SmartScreen dialog choose *More info* → *Run anyway*.
- **Linux:** `chmod +x AgentLens-*.AppImage && ./AgentLens-*.AppImage`, or install the `.deb`.

### Run from source

Requires Node.js 22 or newer.

```sh
git clone https://github.com/aymanlaassel/agentlens.git
cd agentlens
npm install
npm run dev
```

### Build your own installers

```sh
npm run dist          # current platform
npm run dist:mac      # dmg + zip, arm64 and x64
npm run dist:win      # nsis installer + portable exe
npm run dist:linux    # AppImage + deb
```

Output lands in `release/`. Builds are unsigned by default (`identity: null` in `electron-builder.yml`). To sign, set the usual `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables and remove that line.

## Use inside Claude Code or Codex

Build the headless CLI from this checkout, then check discovery for the workspace you want to monitor:

```sh
npm ci --ignore-scripts
npm run build:cli
node dist-cli/index.cjs doctor --project /absolute/path/to/workspace
node dist-cli/index.cjs list --project /absolute/path/to/workspace
```

`--ignore-scripts` skips the Electron download for headless use. Building still requires development dependencies; the resulting `dist-cli/index.cjs` runs with Node.js 22+ alone.

Register the server in your harness, using absolute paths:

```sh
claude mcp add --transport stdio --scope local agentlens -- node /absolute/path/to/agentlens/dist-cli/index.cjs mcp --project /absolute/path/to/workspace
codex mcp add agentlens -- node /absolute/path/to/agentlens/dist-cli/index.cjs mcp --project /absolute/path/to/workspace
```

The tools list recent runs, inspect recorded agents, diagnose failures, and explain missing session directories. They use the same local provider parsers as the desktop app. Scope defaults to the current directory; transcript excerpts require an explicit opt-in.

See [Harness integration](docs/harness-integration.md) for project-local configuration, bounded outputs, suggested harness guidance, and limitations. MCP registration makes the tools available; it does not force the harness to call them. The [dependency note](docs/harness-integration.md#dependencies-and-build-footprint) explains the official SDK choice and build footprint.

## How session discovery works

AgentLens reads two directory trees. Both are configurable in Settings.

| Provider | Default location | What is read |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` | `<project>/<session>.jsonl` for the main agent, `<project>/<session>/subagents/agent-*.jsonl` and `.meta.json` for subagents |
| Codex | `$CODEX_HOME/sessions` or `~/.codex/sessions` | `YYYY/MM/DD/rollout-*.jsonl` |

On startup only the first and last chunks of each file are read, which is enough to list a run with its title, project, branch, and status. A run is parsed in full when you select it or when its token total scrolls into view. A file watcher re-parses the open run as the agent writes to it and refreshes the others cheaply.

How the pieces are derived:

- **Project name:** the git repository root containing the session's working directory, otherwise the last path segment. Codex sessions use the repository URL when present. Sessions started by scheduled Claude jobs are grouped under "Claude scheduled jobs".
- **Run title:** the harness-generated title when one exists, otherwise your first prompt trimmed to about 60 characters.
- **Subagent task:** the `description` and `prompt` from the parent's `Agent` (or legacy `Task`) tool call, matched through the subagent's `.meta.json` or, for older logs, by prompt text.
- **Status:** *Running* while the log changed within the idle window (45 s by default), *Finished* when the subagent handed back or the session is old, *Errored* on an API error or a failing final tool call, *Idle* otherwise.
- **Cost:** token counts from the logs times the per-model prices in Settings. Models without a price show "Set pricing" instead of a guess.

## Chat

AgentLens is also the place you open to talk to Claude about a project. Press `c` (or click **New chat** in the sidebar), pick a working directory, and start typing.

The other side of the conversation is the **Conductor**: a headless Claude Code session (`claude -p`) started with a fixed `--session-id` and continued with `--resume` on every message. It runs with the same flags as the `read-only` permission level (see [Permission levels](#permission-levels)) and is limited to 25 turns per reply.

The Conductor answers questions and reads the code itself, but it never edits files or runs commands. When you ask for work to be done, it ends its reply with a fenced `agentlens` block:

````
```agentlens
{"action":"run-workflow","templateId":"plan-build-review","goal":"<self-contained goal>"}
```
````

Use `"roleIds": ["planner", "coder"]` instead of `templateId` for a custom sequence. AgentLens then:

1. Removes the block from the reply you see.
2. Starts the workflow in the chat's working directory and adds a "Started workflow" event to the chat. Click it to open the workflow.
3. When the workflow ends, sends the Conductor each step's status and the final output, and the Conductor summarises the result for you.

If a block is malformed (invalid JSON, unknown action, no goal, or no template or roles), it stays visible in the reply and an error note explains why.

| Key | Action |
| --- | --- |
| `c` | New chat |
| `Enter` | Send |
| `Shift+Enter` | New line |

- Chats are saved as one JSON file each in `<userData>/chats/`. A reply that was still in progress when AgentLens closed is marked errored on the next launch.
- **Stop** cancels the reply in progress.
- Each message is a Claude Code turn billed to your own Claude account. Nothing goes through AgentLens servers; there are none.

## Workflows

AgentLens can also run agents, not just watch them. A workflow is an ordered list of roles; each role is a headless Claude Code session (`claude -p`) that receives the goal plus the previous step's final output. Pick a template, describe the goal, choose a working directory, and press Start (or press `n` to open the New workflow dialog).

| Template | Roles |
| --- | --- |
| Plan, build, review | Planner → Coder → Reviewer |
| Plan and build | Planner → Coder |
| Build | Coder |
| Operate | Operator |
| Review pull request | PR analyst |
| Review and merge pull request | PR analyst → PR merger |

You can also pick any custom sequence of roles instead of a template.

Each step is started with a pre-assigned `--session-id`, so it appears in the sidebar as soon as Claude Code writes its log, and the step card links straight to that run. The step's result text is pasted into the next role's prompt under "Output from the previous step".

### Built-in roles

| Role | Permission | What it does |
| --- | --- | --- |
| Planner | read-only | Reads the codebase and writes a step-by-step plan. |
| Coder | edit | Implements the plan it is given and runs the tests. |
| Reviewer | read-only | Reviews the changes for bugs and reports findings. |
| Operator | full | Carries out tasks on the computer with full shell access. |
| PR analyst | read-only + gh | Inspects a pull request with the GitHub CLI and reports a verdict. |
| PR merger | read-only + gh | Merges a pull request only when the goal authorizes it, the analyst approved, and checks pass. Requires the setting below. |

The two PR roles run `gh pr view`, `gh pr diff`, `gh pr checks`, and (merger only) `gh pr merge` through the spawned Claude Code session. They need the GitHub CLI installed and authenticated (`gh auth status`). The other roles stay offline.

### Permission levels

Each level maps directly to Claude Code CLI flags. `WebFetch` and `WebSearch` are disallowed at every level except `full`.

| Level | Flags |
| --- | --- |
| `read-only` | `--permission-mode dontAsk`, allowed `Read`, `Grep`, `Glob`, `LS`, `TodoWrite`; disallowed `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` |
| `edit` | `--permission-mode acceptEdits`, the read-only tools plus `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(npm test:*)`, `Bash(npm run:*)`, `Bash(npx vitest:*)`, `Bash(npx tsc:*)` |
| `full` | `--permission-mode bypassPermissions` |

**Warning:** a `full` role runs any shell command without asking. Use it only for roles you trust with your machine, and only in directories you can afford to lose.

A role's `extraTools` are appended to the allowed list at any level, so an `edit` role can be granted `Bash(npm run build:*)` without going `full`.

A `read-only` role whose `extraTools` includes `Bash(...)` patterns drops the bare `Bash` entry from the disallowed list; `--permission-mode dontAsk` still limits it to exactly the listed command patterns.

### Custom roles

Put a `roles.json` in the app's user-data directory:

- macOS: `~/Library/Application Support/AgentLens/roles.json`
- Linux: `~/.config/AgentLens/roles.json`
- Windows: `%APPDATA%/AgentLens/roles.json`

It is a JSON array of role definitions. A role with the same `id` as a built-in one replaces it. Invalid entries are skipped and a warning is logged to the main-process console.

```json
[
  {
    "id": "docs-writer",
    "name": "Docs writer",
    "description": "Updates the README to match the code.",
    "systemPrompt": "You are the Docs writer. Update README.md to describe the changes you are given. Do not touch source files.",
    "permission": "edit",
    "maxTurns": 40,
    "model": "sonnet",
    "extraTools": ["Bash(npm run lint:*)"]
  }
]
```

`id` must be lowercase letters, digits, or dashes; `name`, `systemPrompt`, and `permission` (`read-only`, `edit`, or `full`) are required; `description`, `maxTurns` (1–500), `model`, and `extraTools` are optional.

### State and settings

- Workflow state is saved as one JSON file per run in `<userData>/workflows/`, so finished workflows survive restarts. A workflow that was still running when AgentLens was closed cannot be resumed and is marked errored on the next launch.
- Settings → Workflows → **Claude Code CLI path** sets the binary to run. Leave it blank to auto-detect `claude` from `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`.
- Settings → Workflows → **Allow agents to merge pull requests** gates the PR merger role. It is off by default; starting a workflow that includes a role allowed to run `gh pr merge` fails with an error until it is enabled.
- Workflows reach the Claude API through your own Claude Code install and account. AgentLens itself still makes no network requests.

## Privacy

The session reader runs locally and leaves imported session logs unchanged.

- Discovery reads the configured session directories and resolves working directories against local repository roots.
- AgentLens makes no network requests and has no telemetry, crash reporting, or update check. Desktop chat and workflows spawn your own Claude Code CLI, which communicates through your account. Optional MCP responses go to the connected harness, which may send them to its model provider.
- CLI/MCP responses omit prompt-derived titles, commands, and tool results by default. Metadata still includes paths, identifiers, timing, and usage. Bounded text excerpts require `--include-text`; MCP calls also require `includeText: true`.
- Preferences, desktop chats, and workflow state are saved in the app's local user-data directory. Headless queries do not persist their results.

If you share screenshots or bug reports, scrub them first: transcripts frequently contain secrets.

## Development

```sh
npm run dev         # Vite + Electron with live reload
npm run typecheck   # tsc for renderer and main
npm run lint        # eslint
npm test            # vitest, fixtures in tests/fixtures
npm run test:cli     # compiled CLI + real stdio MCP, synthetic sessions only
npm run build       # production renderer + main + CLI bundles
```

Layout:

```
src/core       pure parsers and derivations (no Electron), fully unit tested
src/cli        read-only JSON commands and local stdio MCP tools
src/main       Electron main: discovery, watcher, IPC, settings
src/preload    typed context bridge
src/renderer   React UI
src/shared     types and IPC channel names
tests          vitest suites and small synthetic JSONL fixtures
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a provider or extend the parser.

## Acknowledgements

The idea of visualizing agent session logs as a graph was inspired by [donvito/agent-monitor](https://github.com/donvito/agent-monitor). AgentLens is an independent implementation written from scratch and shares no code with it.

## License

[MIT](LICENSE) © 2026 Ayman Laassel
