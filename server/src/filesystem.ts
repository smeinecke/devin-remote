/**
 * Narrow, root-confined filesystem API for the workspace directory picker.
 *
 * - Every requested path is resolved, canonicalised and verified against
 *   configured/workspace roots before any filesystem operation.
 * - Symbolic links, `..` traversal and non-normalised separators are handled
 *   by canonicalisation + a strict prefix check.
 * - Only child directories are exposed; file contents are never returned.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "./store.js";

const execFileP = promisify(execFile);

export interface FilesystemRoot {
  path: string;
  label: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
  readable: boolean;
  writable: boolean;
}

export interface DirectoryListingResponse {
  path: string;
  parent: string | null;
  root: FilesystemRoot;
  breadcrumbs: { label: string; path: string }[];
  entries: DirectoryEntry[];
  allowed: boolean;
  writable: boolean;
  errorCode?: string;
}

export interface DirectoryValidationResponse {
  input: string;
  resolvedPath: string | null;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  allowed: boolean;
  gitRepository: boolean;
  branch: string | null;
  errorCode?: string;
}

export type DirectoryErrorCode =
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "PATH_ALREADY_EXISTS"
  | "OUTSIDE_ALLOWED_ROOT"
  | "PERMISSION_DENIED"
  | "SYMLINK_ESCAPE"
  | "IO_ERROR";

export interface WorkspaceModeCheck {
  allowed: boolean;
  requiresWritable: boolean;
  reason: string | null;
}

export function checkWorkspaceForMode(
  validation: DirectoryValidationResponse,
  mode: string | undefined | null,
  isolate = false,
): WorkspaceModeCheck {
  if (!validation.allowed || !validation.exists || !validation.isDirectory || !validation.readable) {
    return { allowed: false, requiresWritable: false, reason: null };
  }

  if (isolate) {
    if (!validation.writable) {
      return {
        allowed: false,
        requiresWritable: true,
        reason: "Worktree isolation requires a writable parent directory.",
      };
    }
    return { allowed: true, requiresWritable: true, reason: null };
  }

  if (mode === "ask") {
    return { allowed: true, requiresWritable: false, reason: null };
  }

  if (!validation.writable) {
    return {
      allowed: false,
      requiresWritable: true,
      reason: mode ? `Mode "${mode}" requires a writable workspace.` : "A writable workspace is required.",
    };
  }

  return { allowed: true, requiresWritable: true, reason: null };
}

const HOME = os.homedir();

export function getAllowedRoots(
  primaryCwd: string,
  _store: Store,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = (env.DEVIN_REMOTE_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  return [primaryCwd];
}

function hasNullBytes(input: string): boolean {
  return input.includes("\0");
}

function isValidBasename(name: string): boolean {
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (hasNullBytes(name)) return false;
  return true;
}

/**
 * Canonicalise a path. Resolves symlinks where they exist; for a path whose
 * final component does not yet exist, canonicalises the parent and appends
 * the basename.
 */
async function canonicalPath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  try {
    return await fs.realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;

    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;

    try {
      const realParent = await fs.realpath(parent);
      return path.join(realParent, path.basename(resolved));
    } catch (parentErr) {
      const parentCode = (parentErr as NodeJS.ErrnoException).code;
      if (parentCode === "ENOENT") return resolved;
      throw parentErr;
    }
  }
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function isPathWithinAnyRoot(
  candidate: string,
  roots: string[],
): Promise<{ allowed: boolean; root: string | null }> {
  const best = await findBestRoot(candidate, roots);
  return { allowed: best !== null, root: best };
}

async function findBestRoot(candidate: string, roots: string[]): Promise<string | null> {
  const canonicalCandidate = await canonicalPath(candidate);
  const matches: string[] = [];
  for (const rawRoot of roots) {
    try {
      const root = await canonicalPath(rawRoot);
      if (canonicalCandidate === root || isWithinRoot(root, canonicalCandidate)) {
        matches.push(root);
      }
    } catch {
      // Skip roots that cannot be canonicalised.
    }
  }
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

function buildBreadcrumbs(dir: string, root: string | null): { label: string; path: string }[] {
  if (!root) return [{ label: path.basename(dir) || dir, path: dir }];

  const relative = path.relative(root, dir);
  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: path.basename(root) || root, path: root }];
  let built = root;

  for (const segment of segments) {
    built = path.join(built, segment);
    out.push({ label: segment, path: built });
  }
  return out;
}

async function accessRead(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function accessWrite(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitInfo(dir: string): Promise<{ repository: boolean; branch: string | null }> {
  try {
    const { stdout: top } = await execFileP("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      timeout: 5_000,
    });
    const root = top.trim();
    if (!root) return { repository: false, branch: null };
    const { stdout: branch } = await execFileP("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 5_000,
    });
    return { repository: true, branch: branch.trim() || null };
  } catch {
    return { repository: false, branch: null };
  }
}

const GIT_CACHE_TTL_MS = 5_000;
const gitCache = new Map<string, { value: { repository: boolean; branch: string | null }; expiresAt: number }>();

async function cachedGitInfo(dir: string): Promise<{ repository: boolean; branch: string | null }> {
  const now = Date.now();
  const cached = gitCache.get(dir);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await gitInfo(dir);
  gitCache.set(dir, { value, expiresAt: now + GIT_CACHE_TTL_MS });
  return value;
}

export function rootLabel(p: string): string {
  if (p === HOME || p.startsWith(HOME + path.sep)) {
    return "~" + p.slice(HOME.length);
  }
  return path.basename(p) || p;
}

async function resolveAndCheck(
  input: string,
  roots: string[],
  options: { mustExist?: boolean; mustBeDirectory?: boolean; includeGit?: boolean } = {},
): Promise<DirectoryValidationResponse> {
  if (typeof input !== "string" || hasNullBytes(input)) {
    return {
      input,
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "INVALID_PATH",
    };
  }

  const resolved = path.resolve(input);
  let exists = false;
  let isDirectory = false;
  let canonical: string | null = null;

  try {
    const stat = await fs.stat(resolved);
    exists = true;
    isDirectory = stat.isDirectory();
    canonical = await canonicalPath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      canonical = await canonicalPath(resolved);
    } else if (code === "EACCES" || code === "EPERM") {
      return {
        input,
        resolvedPath: resolved,
        exists: false,
        isDirectory: false,
        readable: false,
        writable: false,
        allowed: false,
        gitRepository: false,
        branch: null,
        errorCode: "PERMISSION_DENIED",
      };
    } else {
      return {
        input,
        resolvedPath: resolved,
        exists: false,
        isDirectory: false,
        readable: false,
        writable: false,
        allowed: false,
        gitRepository: false,
        branch: null,
        errorCode: "IO_ERROR",
      };
    }
  }

  if (!canonical) canonical = resolved;

  const { allowed, root } = await isPathWithinAnyRoot(canonical, roots);

  if (!allowed) {
    const resolvedNoLinks = path.resolve(input);
    const symlinkEscape = canonical !== resolvedNoLinks && !(await isPathWithinAnyRoot(resolvedNoLinks, roots)).allowed;
    return {
      input,
      resolvedPath: canonical,
      exists,
      isDirectory,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: symlinkEscape ? "SYMLINK_ESCAPE" : "OUTSIDE_ALLOWED_ROOT",
    };
  }

  if (options.mustExist && !exists) {
    return {
      input,
      resolvedPath: canonical,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
      errorCode: "PATH_NOT_FOUND",
    };
  }

  if ((options.mustExist || exists) && !isDirectory) {
    return {
      input,
      resolvedPath: canonical,
      exists,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
      errorCode: "NOT_A_DIRECTORY",
    };
  }

  const readable = isDirectory ? await accessRead(canonical) : false;
  if (exists && isDirectory && !readable) {
    return {
      input,
      resolvedPath: canonical,
      exists: true,
      isDirectory: true,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "PERMISSION_DENIED",
    };
  }

  const writable = isDirectory ? await accessWrite(canonical) : false;
  const { repository: gitRepository, branch } =
    options.includeGit && exists && isDirectory
      ? await cachedGitInfo(canonical)
      : { repository: false, branch: null };

  return {
    input,
    resolvedPath: canonical,
    exists,
    isDirectory,
    readable,
    writable,
    allowed: true,
    gitRepository,
    branch,
  };
}

export async function validateDirectory(
  input: string,
  roots: string[],
  options: { includeGit?: boolean; mustExist?: boolean } = {},
): Promise<DirectoryValidationResponse> {
  return resolveAndCheck(input, roots, {
    includeGit: options.includeGit,
    mustExist: options.mustExist ?? true,
    mustBeDirectory: true,
  });
}

export async function listDirectories(
  input: string,
  roots: string[],
  showHidden = false,
): Promise<DirectoryListingResponse> {
  const validation = await resolveAndCheck(input, roots, { mustExist: true, mustBeDirectory: true });

  if (!validation.allowed || validation.errorCode) {
    return {
      path: input,
      parent: null,
      root: { path: "", label: "" },
      breadcrumbs: [],
      entries: [],
      allowed: validation.allowed,
      writable: false,
      errorCode: validation.errorCode ?? "OUTSIDE_ALLOWED_ROOT",
    };
  }

  const dir = validation.resolvedPath!;
  const bestRoot = (await findBestRoot(dir, roots)) ?? dir;
  const rootObj: FilesystemRoot = { path: bestRoot, label: rootLabel(bestRoot) };
  const breadcrumbs = buildBreadcrumbs(dir, bestRoot);
  let entries: DirectoryEntry[] = [];
  const writable = await accessWrite(dir).catch(() => false);

  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") && !showHidden) continue;

      const childPath = path.join(dir, item.name);
      const childCanonical = await canonicalPath(childPath);
      const { allowed: childAllowed } = await isPathWithinAnyRoot(childCanonical, roots);
      if (!childAllowed) continue;

      let isDir = item.isDirectory();
      if (item.isSymbolicLink()) {
        try {
          const st = await fs.stat(childPath);
          isDir = st.isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;

      entries.push({
        name: item.name,
        path: childCanonical,
        hidden: item.name.startsWith("."),
        readable: await accessRead(childCanonical),
        writable: await accessWrite(childCanonical),
      });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      path: dir,
      parent: null,
      root: rootObj,
      breadcrumbs,
      entries: [],
      allowed: true,
      writable: false,
      errorCode: code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "IO_ERROR",
    };
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(dir);
  let parentEntry: string | null = null;
  if (dir !== bestRoot && parent !== dir) {
    const parentCanonical = await canonicalPath(parent);
    if (isWithinRoot(bestRoot, parentCanonical)) {
      parentEntry = parentCanonical;
    }
  }

  return {
    path: dir,
    parent: parentEntry,
    root: rootObj,
    breadcrumbs,
    entries,
    allowed: true,
    writable,
  };
}

export interface CreateDirectoryDeps {
  mkdir?: (target: string) => Promise<void>;
  validate?: (input: string, roots: string[], options?: { includeGit?: boolean }) => Promise<DirectoryValidationResponse>;
}

export async function createDirectory(
  parentPath: string,
  name: string,
  roots: string[],
  options: { includeGit?: boolean; deps?: CreateDirectoryDeps } = {},
): Promise<DirectoryValidationResponse> {
  const doMkdir = options.deps?.mkdir ?? fs.mkdir;
  const doValidate = options.deps?.validate ?? validateDirectory;
  if (
    typeof parentPath !== "string" ||
    hasNullBytes(parentPath) ||
    typeof name !== "string" ||
    !isValidBasename(name)
  ) {
    return {
      input: parentPath,
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "INVALID_PATH",
    };
  }

  const parentValidation = await resolveAndCheck(parentPath, roots, {
    mustExist: true,
    mustBeDirectory: true,
    includeGit: false,
  });

  if (!parentValidation.allowed || !parentValidation.exists || !parentValidation.isDirectory || !parentValidation.resolvedPath) {
    return {
      input: parentPath,
      resolvedPath: parentValidation.resolvedPath,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: parentValidation.errorCode ?? "OUTSIDE_ALLOWED_ROOT",
    };
  }

  if (!parentValidation.writable) {
    return {
      input: parentPath,
      resolvedPath: parentValidation.resolvedPath,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "PERMISSION_DENIED",
    };
  }

  const target = path.join(parentValidation.resolvedPath, name);
  let created = false;

  try {
    const preValidation = await doValidate(target, roots, { includeGit: options.includeGit ?? false });
    if (preValidation.errorCode !== "PATH_NOT_FOUND") {
      if (!preValidation.allowed) {
        return { ...preValidation, input: parentPath };
      }
      return { ...preValidation, input: parentPath, errorCode: "PATH_ALREADY_EXISTS" };
    }

    await doMkdir(target);
    created = true;

    const result = await doValidate(target, roots, { includeGit: options.includeGit ?? false });
    if (!result.allowed || !result.exists || !result.isDirectory) {
      if (created) {
        await fs.rmdir(target).catch(() => {});
      }
      return {
        input: parentPath,
        resolvedPath: result.resolvedPath ?? target,
        exists: result.exists,
        isDirectory: result.isDirectory,
        readable: false,
        writable: false,
        allowed: false,
        gitRepository: false,
        branch: null,
        errorCode: result.errorCode ?? "IO_ERROR",
      };
    }

    return { ...result, input: parentPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = await doValidate(target, roots, { includeGit: false });
      if (!existing.allowed) {
        return { ...existing, input: parentPath };
      }
      if (existing.errorCode && existing.errorCode !== "NOT_A_DIRECTORY") {
        return { ...existing, input: parentPath };
      }
      return { ...existing, input: parentPath, errorCode: "PATH_ALREADY_EXISTS" };
    }
    return {
      input: parentPath,
      resolvedPath: target,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "IO_ERROR",
    };
  }
}

export async function listRoots(primaryCwd: string, store: Store, env?: NodeJS.ProcessEnv): Promise<FilesystemRoot[]> {
  const configured = getAllowedRoots(primaryCwd, store, env);
  const seen = new Set<string>();
  const out: FilesystemRoot[] = [];

  for (const raw of configured) {
    try {
      const canonical = await canonicalPath(raw);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) continue;
      await fs.access(canonical, fsConstants.R_OK);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push({ path: canonical, label: rootLabel(canonical) });
    } catch {
      // Skip roots that no longer exist or are not readable directories.
    }
  }

  return out;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

async function canonicalRecentPath(
  raw: string,
  roots: string[],
): Promise<string | null> {
  if (!raw) return null;
  const v = await validateDirectory(raw, roots, { includeGit: false });
  if (!v.allowed || !v.exists || !v.isDirectory || !v.readable || !v.resolvedPath) return null;
  return v.resolvedPath;
}

async function canonicalizeStoredPath(raw: string): Promise<string | null> {
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;
    return await canonicalPath(resolved);
  } catch {
    // Drop stale or missing entries. Existing directories outside the current
    // trusted roots are still retained so they can reappear when their root is
    // added back, but missing paths are not useful to keep.
    return null;
  }
}

export async function listRecentWorkspaces(
  primaryCwd: string,
  store: Store,
  env?: NodeJS.ProcessEnv,
  max = 20,
): Promise<string[]> {
  const roots = getAllowedRoots(primaryCwd, store, env);
  const seen = new Set<string>();
  const recent: string[] = [];

  function addCanonical(canonical: string | null) {
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    recent.push(canonical);
  }

  // Canonicalise the stored MRU list for deduplication, but do not drop legacy
  // entries that happen to be outside the current trusted roots. They remain in
  // the store and will reappear in the picker if the user adds their root.
  const rawWorkspaces = store.workspaces();
  const storedCandidates = await mapWithLimit(rawWorkspaces, 4, canonicalizeStoredPath);
  const canonicalWorkspaces: string[] = [];
  for (const canonical of storedCandidates) {
    if (!canonical || canonicalWorkspaces.includes(canonical)) continue;
    canonicalWorkspaces.push(canonical);
  }
  if (!arraysEqual(rawWorkspaces, canonicalWorkspaces)) {
    store.setWorkspaces(canonicalWorkspaces);
  }

  // The picker only surfaces paths that are inside the trusted roots.
  addCanonical(await canonicalRecentPath(primaryCwd, roots));
  for (const w of canonicalWorkspaces) {
    addCanonical(await canonicalRecentPath(w, roots));
  }

  const sessions = Object.values(store.sessions()).sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const sessionCwds = sessions
    .filter((s): s is NonNullable<typeof s> => !!s && !(s.worktree && s.cwd === s.worktree))
    .map((s) => s.cwd);
  const sessionCandidates = await mapWithLimit(sessionCwds, 4, (cwd) => canonicalRecentPath(cwd, roots));
  for (const canonical of sessionCandidates) {
    addCanonical(canonical);
  }

  return recent.slice(0, max);
}
