import type {
  ActiveOperation,
  DirectoryListingResponse,
  DirectoryValidationResponse,
  FilesystemRoot,
  MaterializedSessionState,
  MetaResponse,
  PromptBlock,
  PromptDoneResult,
  SessionSummary,
  SessionUpdate,
  Settings,
  UploadMeta,
  UsageResponse,
} from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${method} ${url} → ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: () => req<MetaResponse>("GET", "/api/meta"),

  listSessions: () => req<{ sessions: SessionSummary[] }>("GET", "/api/sessions"),

  createSession: (cwd: string, isolate?: boolean, mode?: string) =>
    req<{ sessionId: string; processGeneration: number; cwd: string; branch: string | null; worktree: string | null; modes: unknown }>("POST", "/api/sessions", { cwd, isolate, mode }),

  attachSession: (sessionId: string) =>
    req<{ ok: boolean; status: string; processGeneration: number; sessionId: string; running: boolean; cancellable: boolean; activeOperation: ActiveOperation | null }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/attach`,
    ),

  openSession: (sessionId: string, cwd?: string) =>
    req<{
      ok: boolean;
      status: string;
      processGeneration: number;
      sessionId: string;
      branch: string | null;
      worktree: string | null;
      running: boolean;
      cancellable: boolean;
      activeOperation: ActiveOperation | null;
    }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/open`, { cwd }),

  prompt: (sessionId: string, blocks: PromptBlock[]) =>
    req<PromptDoneResult>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { blocks }),

  cancel: (sessionId: string, body: { processGeneration: number; operationId?: string | null }) =>
    req<
      | { ok: true; status: string; processGeneration: number; running: boolean; cancellable: boolean; activeOperation: ActiveOperation | null }
      | { ok: false; error: { code: string; message: string }; state: MaterializedSessionState | null }
    >("POST", `/api/sessions/${encodeURIComponent(sessionId)}/cancel`, body),

  rename: (sessionId: string, title: string) =>
    req<{ ok: boolean; remote: boolean }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/rename`, { title }),

  setConfig: (sessionId: string, configId: "mode" | "model", value: string) =>
    req<unknown>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/config`, { configId, value }),

  closeSession: (sessionId: string) =>
    req<{ ok: boolean }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/close`, {}),

  dropSession: (sessionId: string) =>
    req<{ ok: boolean }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/drop`, {}),

  history: (sessionId: string) =>
    req<{ updates: SessionUpdate[] }>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/history`),

  exportUrl: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/export`,

  resolvePermission: (requestId: string, optionId: string | null) =>
    req<{ ok: boolean }>("POST", `/api/permissions/${encodeURIComponent(requestId)}`, { optionId }),

  upload: async (file: Blob, filename: string): Promise<UploadMeta> => {
    const res = await fetch(`/api/uploads?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed → ${res.status}`);
    return (await res.json()) as UploadMeta;
  },

  filesystemRoots: () => req<{ roots: FilesystemRoot[] }>("GET", "/api/filesystem/roots"),

  listDirectories: (path: string, showHidden = false) => {
    const q = new URLSearchParams({ path });
    if (showHidden) q.set("hidden", "true");
    return req<DirectoryListingResponse>("GET", `/api/filesystem/directories?${q.toString()}`);
  },

  validateDirectory: (path: string) =>
    req<DirectoryValidationResponse>("POST", "/api/filesystem/validate-directory", { path }),

  createDirectory: (path: string) =>
    req<DirectoryValidationResponse>("POST", "/api/filesystem/create-directory", { path }),

  usage: () => req<UsageResponse>("GET", "/api/usage"),

  getSettings: () => req<Settings>("GET", "/api/settings"),

  putSettings: (patch: Partial<Settings>) => req<Settings>("PUT", "/api/settings", patch),
};
