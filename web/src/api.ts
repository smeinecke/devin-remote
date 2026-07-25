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

export class ApiResponseError<T = unknown> extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: T | null,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDirectoryListingResponse(value: unknown): value is DirectoryListingResponse {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    (typeof value.parent === "string" || value.parent === null) &&
    isObject(value.root) &&
    typeof (value.root as Record<string, unknown>).path === "string" &&
    typeof (value.root as Record<string, unknown>).label === "string" &&
    Array.isArray(value.breadcrumbs) &&
    Array.isArray(value.entries) &&
    typeof value.allowed === "boolean" &&
    typeof value.writable === "boolean"
  );
}

export function isDirectoryValidationResponse(value: unknown): value is DirectoryValidationResponse {
  return (
    isObject(value) &&
    typeof value.input === "string" &&
    (typeof value.resolvedPath === "string" || value.resolvedPath === null) &&
    typeof value.exists === "boolean" &&
    typeof value.isDirectory === "boolean" &&
    typeof value.readable === "boolean" &&
    typeof value.writable === "boolean" &&
    typeof value.allowed === "boolean" &&
    typeof value.gitRepository === "boolean" &&
    (typeof value.branch === "string" || value.branch === null)
  );
}

export function directoryListingFromError(error: unknown): DirectoryListingResponse | null {
  if (!(error instanceof ApiResponseError)) return null;
  const payload = error.payload;
  if (!isDirectoryListingResponse(payload)) return null;
  return payload;
}

export function directoryValidationFromError(error: unknown): DirectoryValidationResponse | null {
  if (!(error instanceof ApiResponseError)) return null;
  const payload = error.payload;
  if (!isDirectoryValidationResponse(payload)) return null;
  return payload;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON response.
  }

  if (!response.ok) {
    const message =
      isObject(payload) && typeof payload.error === "string" ? payload.error : `${method} ${url} → ${response.status}`;
    throw new ApiResponseError(message, response.status, payload);
  }

  return payload as T;
}

export const api = {
  meta: () => req<MetaResponse>("GET", "/api/meta"),

  listSessions: () => req<{ sessions: SessionSummary[] }>("GET", "/api/sessions"),

  createSession: (cwd: string, isolate?: boolean, mode?: string) =>
    req<{
      sessionId: string;
      processGeneration: number;
      cwd: string;
      root: string;
      branch: string | null;
      worktree: string | null;
      modes: unknown;
    }>("POST", "/api/sessions", { cwd, isolate, mode }),

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

  filesystemRecent: () => req<{ recent: string[] }>("GET", "/api/filesystem/recent"),

  listDirectories: (path: string, showHidden = false) => {
    const q = new URLSearchParams({ path });
    if (showHidden) q.set("hidden", "true");
    return req<DirectoryListingResponse>("GET", `/api/filesystem/directories?${q.toString()}`);
  },

  validateDirectory: (path: string) =>
    req<DirectoryValidationResponse>("POST", "/api/filesystem/validate-directory", { path }),

  createDirectory: (params: { parentPath: string; name: string }) =>
    req<DirectoryValidationResponse>("POST", "/api/filesystem/create-directory", params),

  usage: () => req<UsageResponse>("GET", "/api/usage"),

  getSettings: () => req<Settings>("GET", "/api/settings"),

  putSettings: (patch: Partial<Settings>) => req<Settings>("PUT", "/api/settings", patch),
};
