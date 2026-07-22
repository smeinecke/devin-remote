# Refactor Plan — Multi-Session Correctness (v0.4)

## Goals

1. Sessions do not share an ACP process.
2. Session lifecycle operations cannot race.
3. Viewing a session does not reload it.
4. WebSocket reconnect restores all relevant sessions.
5. Events are sequence-numbered and idempotent.
6. Terminals are strictly scoped to their session.
7. Git worktrees isolate concurrent file edits.
8. UI separates conversation, activity, changes, terminal, logs.
9. Mobile and desktop layouts remain usable.
10. Automated concurrency tests pass.

## Status

| Phase | Status | Notes |
| ----- | ------ | ----- |
| 1. Architecture audit | Done | Documented in `AGENTS.md` and the original audit notes. |
| 2. Reproduce with diagnostics | Done | `npm run smoke` creates two concurrent sessions and verifies separate ACP processes; unit tests cover lifecycle/EventBus/terminal scoping. |
| 3. Per-session ACP process | Done | `SessionRegistry` / `SessionController` / `AcpProcess`. |
| 4. Explicit state machine | Done | `lifecycle.ts` + `SessionController` transitions. |
| 5. Idempotent attachment | Done | `SessionController.attach` is a no-op when active; `create` keeps the process. |
| 6. Git worktree isolation | Done | `worktree.ts` integrated in `/api/sessions` POST. |
| 7. Session-scoped event delivery | Done | `EventBus` with per-generation sequences; `WsSubscriber` with cursors/snapshots. |
| 8. Reconnect recovery | Done | WebSocket subscribe messages carry `(processGeneration, after)`; server replays or snapshots. |
| 9. Terminal state scoping | Done | `TerminalManager` keyed by `(sessionId, processGeneration)`; `TerminalPanel` filters strictly. |
| 10. Reduce frontend rerenders | Partial | Store uses `useSyncExternalStore` with selectors and `requestAnimationFrame` batching; components still need further selector adoption. |
| 11. Activity model | Pending | `AgentRun` types exist; UI rendering still flattens tool calls. |
| 12. Desktop layout redesign | Pending | Existing bottom drawers still in place; inspector region planned. |
| 13. Mobile layout redesign | Pending | Sidebar overlay exists; further mobile optimization pending. |
| 14. Security review | Done | CSRF/DNS-rebinding guard, upload caps, path confinement preserved and tightened. |
| 15. Tests | Partial | `npm run test` covers `lifecycle`, `EventBus`, `TerminalManager`; `smoke` covers end-to-end; missing controller/integration/worktree tests. |
| Deliverables | Done | `AGENTS.md` updated, `typecheck`/`build`/`test`/`smoke` passing. |

## Backend modules

| File | Purpose |
| ---- | ------- |
| `server/src/lifecycle.ts` | `SessionStatus` union and valid transitions. |
| `server/src/session-controller.ts` | `SessionController` owns one `AcpProcess` and a lifecycle state machine. |
| `server/src/acp-process.ts` | stdio wrapper around `devin acp` for one session. |
| `server/src/event-bus.ts` | per-(session, generation) bounded buffers with monotonic sequences. |
| `server/src/terminal-manager.ts` | terminal registry keyed by `(sessionId, processGeneration, terminalId)`. |
| `server/src/worktree.ts` | Git worktree creation, sanitization, confinement. |
| `server/src/session-registry.ts` | owns all `SessionController`s and routes REST/WS actions. |
| `server/src/ws-subscriber.ts` | session-scoped WebSocket subscriptions with cursors. |
| `server/src/routes.ts` | REST routing through registry and state machine. |
| `server/src/index.ts` | wiring, static files, security guard. |

## Frontend modules

| File | Purpose |
| ---- | ------- |
| `web/src/state.ts` | normalized store with `useSyncExternalStore` and selectors. |
| `web/src/store-types.ts` | `AppState`, `SessionState`, `AgentRun`, `TerminalState`, etc. |
| `web/src/ws.ts` | sends `{ type: "subscribe", sessions: { id: { processGeneration, after } } }`. |
| `web/src/api.ts` | REST client for new routes. |
| `web/src/types.ts` | shared protocol types including `ServerEventEnvelope`. |
| `web/src/components/TerminalPanel.tsx` | per-session, per-generation terminal panel. |

## Tests

- `server/test/lifecycle.test.ts` — state-machine transitions.
- `server/test/event-bus.test.ts` — monotonic sequences, replay, snapshots, reset.
- `server/test/terminal-manager.test.ts` — terminal creation and scoping.
- `scripts/smoke.ts` — end-to-end against real `devin acp`; verifies per-session processes.

## Migration

- `StoreShape` gained a `sessions` record for persisted metadata (cwd, branch, worktree, alias, status).
- Legacy `aliases` are migrated to `sessions` on first load.
- Web UI subscribes to new envelope shapes; older event formats are not supported.
