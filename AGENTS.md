# Devin Remote — Architecture Notes

## Build / test / run commands

```bash
npm install
npm run dev          # server :7781 + vite :5173
npm run build        # dist/web + dist/server
npm run typecheck    # tsc both projects
npm run test         # all unit tests (server tsx + web vitest)
npm run test:server  # server unit tests (Node test runner + tsx)
npm run test:web     # web unit tests (vitest + happy-dom)
npm run smoke        # e2e against real devin CLI (costs tokens)
npm start            # production server
```

## Architecture (v0.4)

```
Browser (React SPA)
  → HTTP routes (/api/*)          server/src/routes.ts
  → WebSocket (/ws)               server/src/ws-subscriber.ts
  → SessionRegistry               server/src/session-registry.ts
       one SessionController per active session
  → SessionController             server/src/session-controller.ts
       owns one devin acp process, state machine, lifecycle
  → AcpProcess                    server/src/acp-process.ts
       JSON-RPC stdio to a dedicated devin acp child
  → TerminalManager               server/src/terminal-manager.ts
       Map<terminalId, TerminalHandle> with (sessionId, processGeneration) scoping
  → EventBus                      server/src/event-bus.ts
       per-(session, generation) bounded buffers with monotonic sequence numbers
  → Store                         server/src/store.ts
       JSON file: aliases, workspaces, sessions, usage, settings
```

### State keyed by

| Key type          | Where                                      | Notes                                           |
| ----------------- | ------------------------------------------ | ----------------------------------------------- |
| `sessionId`       | `SessionRegistry.controllers`              | one `SessionController` per active session      |
| `ACP process`     | `SessionController.acp`                    | dedicated `devin acp` per session, created/attached on demand |
| `terminalId`      | `TerminalManager.terminals`                | ownership enforced by `(sessionId, processGeneration)`        |
| `browser conn`    | `WsSubscriber.clients`                     | per-session subscription with generation + sequence cursor   |
| `permission`      | `SessionRegistry.permissionOwners`         | request routed to owning `SessionController`    |

## Root causes fixed in the v0.4 refactor

1. **Per-session ACP process** — `SessionRegistry` no longer shares a `devin acp` process by `cwd`. Each `SessionController` owns its own process, eliminating cross-session multiplexing races.
2. **Explicit session state machine** — `lifecycle.ts` defines `SessionStatus` and valid transitions. `prompt`, `cancel`, `attach`, and permission flows are guarded against invalid state transitions.
3. **Idempotent attachment** — `SessionController.attach()` is a no-op when the process is already alive; `SessionController.create()` spawns a process and immediately creates the session in it, keeping that process for the session.
4. **Sequence-numbered, generation-scoped events** — `EventBus` emits per-session/per-generation envelopes with monotonic sequence numbers. `WsSubscriber` replays from cursors and sends snapshots when the cursor is too old.
5. **Strict terminal scoping** — `TerminalManager` stores `sessionId` and `processGeneration` on every handle. `TerminalPanel` only shows terminals belonging to the active session and current process generation.
6. **Git worktree isolation** — `worktree.ts` creates a fresh worktree for new sessions when `settings.worktreeIsolation` is on.
7. **Security guard preserved** — loopback default, CSRF/DNS-rebinding guard, upload caps, path confinement, and no secret logging remain in place.

## Files to know

- `server/src/session-registry.ts` — create, attach, resolve permissions, list sessions, kill all.
- `server/src/session-controller.ts` — lifecycle, ACP process ownership, event emission.
- `server/src/acp-process.ts` — stdio ACP child, callbacks filtered by `sessionId`.
- `server/src/event-bus.ts` — sequenced events, snapshots, replay.
- `server/src/ws-subscriber.ts` — WebSocket subscription server with cursors.
- `server/src/terminal-manager.ts` — scoped terminal registry.
- `server/src/lifecycle.ts` — state machine transitions.
- `server/src/worktree.ts` — Git worktree helpers.
- `web/src/state.ts` — normalized store with selectors.
- `web/src/ws.ts` — cursor-based WebSocket subscriptions.
- `web/src/api.ts` — REST client for the new routes.
- `server/src/filesystem.ts` — server-side path canonicalization, root restriction, and directory operations.
- `web/src/components/WorkspacePathField.tsx` — path input with validation, recent dropdown, and Browse button.
- `web/src/components/DirectoryPickerModal.tsx` — server-side directory browser modal.
- `web/src/utils.ts` — `shortenPath` helper for readable path display.

## Workspace path picker — verification

```bash
npm run typecheck    # both projects
npm run test         # server + web tests
npm run build        # dist/web + dist/server
npm start            # production server on :7781
```

Then open `http://127.0.0.1:7781`, click **Browse…** in the New session area, and confirm:
1. The directory picker lists only directories on the host (not the browser client).
2. Paths outside the configured roots are rejected with an `OUTSIDE_ALLOWED_ROOT` / `SYMLINK_ESCAPE` error.
3. The recent path dropdown shows basename + shortened path, and selecting a recent path updates the input.
4. The **New session** button is enabled only when the selected path is a readable directory inside an allowed root.

## Security limitations

- Root confinement is enforced by `server/src/filesystem.ts` using realpath canonicalization and `path.relative` checks against allowed roots.
- Symlinks are followed only when they resolve inside an allowed root; a symlink that escapes is rejected as `SYMLINK_ESCAPE`.
- `DEVIN_REMOTE_WORKSPACE_ROOTS` overrides the root list at server startup; otherwise roots fall back to the server CWD and stored workspaces.
- The server must run on a trusted host; the filesystem APIs give any authenticated web client the ability to list and create directories within allowed roots.
- Hard links, bind mounts, and other kernel-level aliases can defeat pure path-string confinement; run the server with minimal privileges and restrict roots accordingly.
- No browser-native file picker is used, so client-side path spoofing is not possible.
