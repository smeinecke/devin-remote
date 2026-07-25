import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const execFileP = promisify(execFile);
import type { SessionRegistry } from "./session-registry.js";
import type { Store } from "./store.js";
import type { WsSubscriber } from "./ws-subscriber.js";
import type { UsageRecord } from "./types.js";
import type { SessionMetadata as ControllerSessionMetadata } from "./session-controller.js";
import { saveUpload, serveUpload, uploadPath } from "./uploads.js";
import { buildSessionZip } from "./export.js";
import { findGitRoot, createWorktree, cleanupWorktree, rollbackCreatedWorktree } from "./worktree.js";
import {
  getAllowedRoots,
  listRoots,
  listDirectories,
  listRecentWorkspaces,
  validateDirectory,
  createDirectory,
  checkWorkspaceForMode,
  type DirectoryValidationResponse,
} from "./filesystem.js";

export interface ApiContext {
  store: Store;
  registry: SessionRegistry;
  ws: WsSubscriber;
  appVersion: string;
  primaryCwd: string;
  devinCheck: () => Promise<unknown>;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(data);
}

function httpStatusForErrorCode(code: string | undefined): number {
  switch (code) {
    case "INVALID_PATH":
    case "NOT_A_DIRECTORY":
      return 400;
    case "OUTSIDE_ALLOWED_ROOT":
    case "SYMLINK_ESCAPE":
    case "PERMISSION_DENIED":
      return 403;
    case "PATH_NOT_FOUND":
      return 404;
    case "PATH_ALREADY_EXISTS":
      return 409;
    case "IO_ERROR":
    default:
      return 500;
  }
}

async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString("utf8"));
}

async function resolveCwd(ctx: ApiContext, sessionId: string, preferred?: string): Promise<string> {
  const candidate = preferred ?? ctx.store.session(sessionId)?.cwd ?? ctx.primaryCwd;
  try {
    const st = await fs.stat(candidate);
    if (st.isDirectory()) return candidate;
  } catch {}
  // If the stored worktree was removed (e.g. by git worktree cleanup), fall back.
  return ctx.primaryCwd;
}

async function normalizeBlocks(store: Store, blocks: unknown[]): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const raw of blocks) {
    const b = raw as Record<string, unknown>;
    if (b.type === "image" && typeof b.uploadId === "string") {
      const file = await fs.readFile(uploadPath(store, b.uploadId));
      out.push({
        type: "image",
        data: file.toString("base64"),
        mimeType: String(b.mimeType ?? "image/png"),
      });
    } else {
      out.push(raw as ContentBlock);
    }
  }
  return out;
}

function requireController(ctx: ApiContext, sessionId: string, cwd?: string) {
  const c = ctx.registry.get(sessionId);
  if (!c) throw Object.assign(new Error("unknown session"), { status: 404 });
  if (cwd && c.cwd !== cwd) {
    // Cwd mismatch is a warning but not fatal; the controller is authoritative.
  }
  return c;
}

function controllerMeta(ctx: ApiContext, sessionId: string, cwd?: string): Partial<ControllerSessionMetadata> {
  const meta = ctx.store.session(sessionId);
  return {
    sessionId,
    cwd: cwd ?? meta?.cwd ?? ctx.primaryCwd,
    title: meta?.title ?? null,
    alias: meta?.alias ?? ctx.store.alias(sessionId) ?? null,
    branch: meta?.branch ?? null,
    worktree: meta?.worktree ?? null,
  };
}

export async function handleApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const m = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (m === "GET" && url.pathname === "/api/meta") {
      return json(res, 200, {
        app: { name: "devin-remote", version: ctx.appVersion },
        devin: await ctx.devinCheck(),
        workspaces: await listRecentWorkspaces(ctx.primaryCwd, ctx.store),
        processes: ctx.registry.status(),
        settings: ctx.store.settings,
        primaryCwd: ctx.primaryCwd,
      });
    }

    if (m === "GET" && url.pathname === "/api/sessions") {
      const remote = await ctx.registry.listRemote(ctx.primaryCwd);
      const sessions = [];
      for (const s of remote.sessions ?? []) {
        if (ctx.store.isDropped(s.sessionId)) continue;
        ctx.store.ensureSession(s.sessionId, { cwd: s.cwd, title: s.title ?? null });
        sessions.push({
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title ?? null,
          alias: ctx.store.alias(s.sessionId) ?? null,
          branch: ctx.store.session(s.sessionId)?.branch ?? null,
          worktree: ctx.store.session(s.sessionId)?.worktree ?? null,
          updatedAt: (s as { updatedAt?: string }).updatedAt ?? null,
        });
      }
      return json(res, 200, { sessions });
    }

    if (m === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      const rawCwd = String(body.cwd ?? ctx.primaryCwd);
      const mode = typeof body.mode === "string" ? body.mode : "";
      const isolate = ctx.store.settings.worktreeIsolation && (body.isolate !== false);

      const roots = getAllowedRoots(ctx.primaryCwd, ctx.store);
      const validation = await validateDirectory(rawCwd, roots);
      if (!validation.allowed || !validation.exists || !validation.isDirectory || !validation.readable) {
        return json(res, httpStatusForErrorCode(validation.errorCode), {
          error: validation.errorCode
            ? `${validation.errorCode}: ${rawCwd}`
            : `invalid workspace directory: ${rawCwd}`,
          validation,
        });
      }

      const workspaceCheck = checkWorkspaceForMode(validation, mode, isolate);
      if (!workspaceCheck.allowed) {
        return json(res, 400, {
          error: workspaceCheck.reason ?? `workspace does not meet mode requirements: ${rawCwd}`,
          validation,
          workspaceCheck,
        });
      }

      const canonicalCwd = validation.resolvedPath!;
      const gitRoot = await findGitRoot(canonicalCwd);
      let worktreeInfo: { root: string; worktree: string; branch: string; isIsolated: boolean } = { root: canonicalCwd, worktree: canonicalCwd, branch: "", isIsolated: false };
      let cwd = canonicalCwd;
      if (gitRoot && isolate) {
        const tempId = `new-${Date.now().toString(36)}`;
        const { stdout: headOut } = await execFileP("git", ["-C", canonicalCwd, "rev-parse", "HEAD"], { timeout: 10_000 });
        const baseCommit = headOut.trim();
        worktreeInfo = await createWorktree(tempId, canonicalCwd, gitRoot, baseCommit);
        cwd = worktreeInfo.worktree;
      }

      try {
        const created = await ctx.registry.create(cwd);
        ctx.store.addWorkspace(worktreeInfo.root);
        ctx.store.ensureSession(created.sessionId, {
          cwd,
          title: null,
          branch: worktreeInfo.branch || null,
          worktree: worktreeInfo.worktree,
        });

        return json(res, 200, {
          sessionId: created.sessionId,
          processGeneration: created.processGeneration,
          cwd,
          root: worktreeInfo.root,
          branch: worktreeInfo.branch || null,
          worktree: worktreeInfo.worktree,
          modes: created.modes ?? null,
        });
      } catch (error) {
        if (worktreeInfo.isIsolated) {
          await rollbackCreatedWorktree(worktreeInfo).catch((err) => console.error("rollback cleanup failed:", err));
        }
        throw error;
      }
    }

    if (parts[1] === "sessions" && parts.length >= 4) {
      const id = decodeURIComponent(parts[2]);
      const action = parts[3];

      if (m === "POST" && action === "drop") {
        const c = ctx.registry.get(id);
        if (c) await ctx.registry.drop(id);
        ctx.store.dropSession(id);
        return json(res, 200, { ok: true });
      }

      if (m === "POST" && action === "open") {
        const body = await readJson(req);
        const cwd = await resolveCwd(ctx, id, body.cwd ? String(body.cwd) : undefined);
        await ctx.registry.attach(id, cwd, controllerMeta(ctx, id, cwd));
        const c = ctx.registry.get(id)!;
        return json(res, 200, {
          ok: true,
          status: c.currentStatus,
          processGeneration: c.processGeneration,
          sessionId: c.sessionId,
          branch: c.branch,
          worktree: c.worktree,
          running: c.isRunning,
          cancellable: c.isCancellable,
          activeOperation: c.activeOperationSnapshot,
        });
      }

      if (m === "POST" && action === "attach") {
        const body = await readJson(req);
        const cwd = await resolveCwd(ctx, id, body.cwd ? String(body.cwd) : undefined);
        await ctx.registry.attach(id, cwd, controllerMeta(ctx, id, cwd));
        const c = ctx.registry.get(id)!;
        return json(res, 200, {
          ok: true,
          status: c.currentStatus,
          processGeneration: c.processGeneration,
          sessionId: c.sessionId,
          running: c.isRunning,
          cancellable: c.isCancellable,
          activeOperation: c.activeOperationSnapshot,
        });
      }

      if (m === "POST" && action === "prompt") {
        const body = await readJson(req);
        const blocks = await normalizeBlocks(ctx.store, (body.blocks as unknown[]) ?? []);
        if (blocks.length === 0) return json(res, 400, { error: "empty prompt" });
        let c = ctx.registry.get(id);
        if (!c) {
          const cwd = await resolveCwd(ctx, id, body.cwd ? String(body.cwd) : undefined);
          await ctx.registry.attach(id, cwd, controllerMeta(ctx, id, cwd));
          c = ctx.registry.get(id)!;
        } else {
          const cwd = await resolveCwd(ctx, id, c.cwd);
          await ctx.registry.attach(id, cwd);
        }
        const done = await c.prompt(blocks);
        const usage = (done as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
        if (usage?.totalTokens) {
          const rec: UsageRecord = {
            ts: Date.now(),
            sessionId: c.sessionId,
            cwd: c.cwd,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens,
          };
          ctx.store.recordUsage(rec);
        }
        return json(res, 200, done);
      }

      const c = requireController(ctx, id);

      if (m === "POST" && action === "cancel") {
        const body = await readJson(req);
        try {
          await c.cancel({
            processGeneration: typeof body.processGeneration === "number" ? body.processGeneration : undefined,
            operationId: typeof body.operationId === "string" ? body.operationId : undefined,
          });
        } catch (err) {
          const e = err as Error & { code?: string; state?: unknown; status?: number };
          const status = e.status ?? 409;
          return json(res, status, {
            ok: false,
            error: { code: e.code ?? "NO_ACTIVE_PROMPT", message: e.message },
            state: e.state,
          });
        }
        const snap = c.snapshot();
        return json(res, 200, {
          ok: true,
          status: snap.status,
          processGeneration: snap.processGeneration,
          running: snap.running,
          cancellable: snap.cancellable,
          activeOperation: snap.activeOperation,
        });
      }

      if (m === "POST" && action === "rename") {
        const body = await readJson(req);
        const title = String(body.title ?? "").trim();
        const remote = title ? await c.rename(title) : false;
        ctx.store.setAlias(id, title);
        return json(res, 200, { ok: true, remote });
      }

      if (m === "POST" && action === "config") {
        const body = await readJson(req);
        const result = await c.setConfig(String(body.configId), String(body.value));
        return json(res, 200, result ?? { ok: true });
      }

      if (m === "POST" && action === "close") {
        ctx.registry.close(id);
        return json(res, 200, { ok: true });
      }

      if (m === "GET" && action === "export") {
        const events = ctx.registry.eventBus.replay(id, c.processGeneration, 0) ?? [];
        const zip = buildSessionZipFromEvents(events, id, {
          cwd: c.cwd,
          alias: ctx.store.alias(id) ?? null,
          app: `devin-remote ${ctx.appVersion}`,
        });
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="devin-session-${id}.zip"`,
          "content-length": zip.length,
        });
        res.end(Buffer.from(zip));
        return;
      }

      if (m === "GET" && action === "history") {
        const events = ctx.registry.eventBus.replay(id, c.processGeneration, 0) ?? [];
        return json(res, 200, { updates: events.filter((e) => e.type === "session_update").map((e) => e.payload) });
      }

      if (m === "POST" && action === "cleanup-worktree") {
        const wt = ctx.store.session(id)?.worktree;
        if (wt) await cleanupWorktree(wt);
        return json(res, 200, { ok: true });
      }
    }

    if (m === "POST" && parts[1] === "permissions" && parts.length === 3) {
      const requestId = decodeURIComponent(parts[2]);
      const body = await readJson(req);
      const ok = ctx.registry.resolvePermission(requestId, (body.optionId as string | null) ?? null);
      return json(res, ok ? 200 : 404, { ok });
    }

    if (m === "POST" && url.pathname === "/api/uploads") {
      const filename = url.searchParams.get("filename") ?? "file";
      const meta = await saveUpload(req, ctx.store, filename);
      return json(res, 200, { ...meta, url: `/api/uploads/${encodeURIComponent(meta.id)}` });
    }

    if (m === "GET" && parts[1] === "uploads" && parts.length === 3) {
      return serveUpload(ctx.store, decodeURIComponent(parts[2]), res);
    }

    if (m === "GET" && url.pathname === "/api/usage") {
      const records = ctx.store.usage();
      const byDay: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; turns: number }> = {};
      let input = 0, output = 0;
      for (const r of records) {
        const day = new Date(r.ts).toISOString().slice(0, 10);
        (byDay[day] ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 });
        byDay[day].inputTokens += r.inputTokens;
        byDay[day].outputTokens += r.outputTokens;
        byDay[day].totalTokens += r.totalTokens;
        byDay[day].turns += 1;
        input += r.inputTokens;
        output += r.outputTokens;
      }
      return json(res, 200, {
        totals: { inputTokens: input, outputTokens: output, totalTokens: input + output, turns: records.length },
        byDay,
        recent: records.slice(-200).reverse(),
      });
    }

    if (url.pathname === "/api/settings") {
      if (m === "GET") return json(res, 200, ctx.store.settings);
      if (m === "PUT" || m === "POST") {
        const body = await readJson(req);
        return json(res, 200, ctx.store.setSettings(body));
      }
    }

    if (m === "GET" && url.pathname === "/api/filesystem/roots") {
      const roots = await listRoots(ctx.primaryCwd, ctx.store);
      return json(res, 200, { roots });
    }

    if (m === "GET" && url.pathname === "/api/filesystem/recent") {
      const recent = await listRecentWorkspaces(ctx.primaryCwd, ctx.store);
      return json(res, 200, { recent });
    }

    if (m === "GET" && url.pathname === "/api/filesystem/directories") {
      const target = url.searchParams.get("path") ?? "";
      const showHidden = url.searchParams.get("hidden") === "true";
      const roots = getAllowedRoots(ctx.primaryCwd, ctx.store);
      const listing = await listDirectories(target, roots, showHidden);
      return json(res, listing.allowed && !listing.errorCode ? 200 : httpStatusForErrorCode(listing.errorCode), listing);
    }

    if (m === "POST" && url.pathname === "/api/filesystem/validate-directory") {
      const body = await readJson(req);
      const target = String(body.path ?? "");
      const roots = getAllowedRoots(ctx.primaryCwd, ctx.store);
      const result = await validateDirectory(target, roots, { includeGit: true });
      return json(res, result.allowed && !result.errorCode ? 200 : httpStatusForErrorCode(result.errorCode), result);
    }

    if (m === "POST" && url.pathname === "/api/filesystem/create-directory") {
      const body = await readJson(req);
      const parentPath = String(body.parentPath ?? "");
      const name = String(body.name ?? "");
      const roots = getAllowedRoots(ctx.primaryCwd, ctx.store);
      const result = await createDirectory(parentPath, name, roots);
      return json(res, result.exists && result.isDirectory && result.allowed ? 200 : httpStatusForErrorCode(result.errorCode), result);
    }

    json(res, 404, { error: `not found: ${m} ${url.pathname}` });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}

function buildSessionZipFromEvents(events: any[], sessionId: string, meta: { cwd: string | null; alias: string | null; app: string }): Uint8Array {
  // Reuse the existing exporter on the raw session-update payloads.
  const log = {
    append: () => {},
    get: () => events.filter((e) => e.type === "session_update").map((e) => ({ ts: e.timestamp ?? Date.now(), update: e.payload })),
  };
  return buildSessionZip(log as any, sessionId, meta);
}
