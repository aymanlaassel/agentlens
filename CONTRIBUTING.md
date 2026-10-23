# Contributing to AgentLens

Thanks for helping. This document covers the workflow and the parts of the code you are most likely to touch.

## Setup

```sh
npm install
npm run dev
```

Node.js 22 or newer is required. The dev script starts Vite on port 5174, bundles the main process with esbuild, and launches Electron against your real session directories.

## Before you open a pull request

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:cli
```

CI runs these commands on macOS, Windows, and Linux. The CLI smoke test uses disposable synthetic sessions and needs no harness login. Keep TypeScript strict; do not add `any` or `@ts-ignore` to get past an error.

## Project layout

- `src/core` is pure TypeScript with no Electron or Node dependency beyond types. Every parser and derivation lives here so it can be unit tested with fixtures. If you find yourself importing `electron` or `node:fs` in `src/core`, stop and inject the dependency instead (see `isGitRoot` in `resolveProject`).
- `src/main` owns the filesystem: discovery, the chokidar watcher, settings persistence, and IPC handlers.
- `src/cli` exposes bounded, read-only queries over the same parsers through JSON commands and stdio MCP. Keep stdout reserved for protocol messages in MCP mode; diagnostics belong on stderr.
- `src/preload` exposes a small typed API on `window.agentlens`. Add a channel name to `src/shared/ipc.ts`, a handler in `src/main/ipc.ts`, and a method in `src/preload/index.ts`.
- `src/renderer` is the React UI. State lives in a single zustand store (`store.ts`); derived lists are in `lib/selectors.ts`.

## Adding or fixing a parser

1. Capture a **small, synthetic** JSONL fixture under `tests/fixtures/`. Hand-write it or scrub a real one: fake paths like `/home/dev/projects/...`, no real prompts, no secrets. Fixtures should be a few KB at most.
2. Write the failing test in `tests/*.test.ts`.
3. Implement in `src/core/<provider>/`. Keep records tolerant: unknown fields are ignored and malformed lines are skipped, because the file is often mid-write.
4. If a tool name needs a human description, add a case to `describeToolCall` in `src/core/activity.ts`.

To add a new provider: create `src/core/<provider>/session.ts` returning a `RunDetail`, add a header function and location type in `src/main/discovery.ts`, extend the `Provider` union in `src/shared/types.ts`, and add a label in the sidebar.

## UI guidelines

- Status is never color alone. Pair every status color with an icon or text.
- Every interactive element is reachable by keyboard and has a visible focus ring and an `aria-label` when its text is not descriptive.
- Prefer CSS variables in `styles.css` over hardcoded colors so both themes stay in sync.
- No new runtime dependencies without a sentence in the PR explaining why the standard library or an existing dependency does not cover it.

## Privacy rule

AgentLens must never make a network request or persist imported transcript content. Pull requests that add telemetry, remote fetches, or cloud sync will not be merged. Headless responses contain bounded metadata by default; text excerpts need explicit startup permission and a per-call opt-in in MCP mode. Explain that the connected harness can send returned data to its model provider.

## Commit messages

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Explain the why in the body when it is not obvious.
