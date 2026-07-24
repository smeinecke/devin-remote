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
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = (env.DEVIN_REMOTE_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  const roots = new Set<string>();
  roots.add(primaryCwd);
  for (const w of store.workspaces()) {
    if (w) roots.add(w);
  }
  return [...roots];
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
  const canonicalCandidate = await canonicalPath(candidate);
  for (const rawRoot of roots) {
    const root = await canonicalPath(rawRoot);
    if (isWithinRoot(root, canonicalCandidate)) {
      return { allowed: true, root };
    }
  }
  return { allowed: false, root: null };
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

export function rootLabel(p: string): string {
  if (p === HOME || p.startsWith(HOME + path.sep)) {
    return "~" + p.slice(HOME.length);
  }
  return path.basename(p) || p;
}

async function resolveAndCheck(
  input: string,
  roots: string[],
  options: { mustExist?: boolean; mustBeDirectory?: boolean } = {},
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
  const writable = isDirectory ? await accessWrite(canonical) : false;
  const { repository: gitRepository, branch } = exists && isDirectory ? await gitInfo(canonical) : { repository: false, branch: null };

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
): Promise<DirectoryValidationResponse> {
  return resolveAndCheck(input, roots);
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
      entries: [],
      allowed: validation.allowed,
      writable: false,
      errorCode: validation.errorCode ?? "OUTSIDE_ALLOWED_ROOT",
    };
  }

  const dir = validation.resolvedPath!;
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
      entries: [],
      allowed: true,
      writable: false,
      errorCode: code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "IO_ERROR",
    };
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(dir);
  let parentEntry: string | null = null;
  if (parent !== dir) {
    const parentCanonical = await canonicalPath(parent);
    const { allowed: parentAllowed } = await isPathWithinAnyRoot(parentCanonical, roots);
    if (parentAllowed) parentEntry = parentCanonical;
  }

  return {
    path: dir,
    parent: parentEntry,
    entries,
    allowed: true,
    writable,
  };
}

export async function createDirectory(
  input: string,
  roots: string[],
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
  const name = path.basename(resolved);
  if (!isValidBasename(name)) {
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
      errorCode: "INVALID_PATH",
    };
  }

  const parent = path.dirname(resolved);
  const parentValidation = await resolveAndCheck(parent, roots, { mustExist: true, mustBeDirectory: true });
  if (!parentValidation.allowed || !parentValidation.exists || !parentValidation.isDirectory || !parentValidation.resolvedPath || !parentValidation.writable) {
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
      errorCode: parentValidation.errorCode ?? "OUTSIDE_ALLOWED_ROOT",
    };
  }

  const canonicalParent = parentValidation.resolvedPath;
  const target = path.join(canonicalParent, name);
  let created = false;

  try {
    try {
      const existing = await fs.realpath(target);
      // Target already exists or is a symlink. Validate what it resolves to.
      const existingValidation = await validateDirectory(existing, roots);
      if (!existingValidation.allowed) {
        return {
          input,
          resolvedPath: existing,
          exists: existingValidation.exists,
          isDirectory: existingValidation.isDirectory,
          readable: false,
          writable: false,
          allowed: false,
          gitRepository: false,
          branch: null,
          errorCode: existingValidation.errorCode ?? "OUTSIDE_ALLOWED_ROOT",
        };
      }
      if (existingValidation.exists && existingValidation.isDirectory) {
        return existingValidation;
      }
      return {
        input,
        resolvedPath: existing,
        exists: true,
        isDirectory: false,
        readable: false,
        writable: false,
        allowed: true,
        gitRepository: false,
        branch: null,
        errorCode: "NOT_A_DIRECTORY",
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }

    await fs.mkdir(target);
    created = true;

    const result = await validateDirectory(target, roots);
    if (!result.allowed || !result.exists || !result.isDirectory) {
      if (created) {
        await fs.rmdir(target).catch(() => {});
      }
      return {
        input,
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

    return result;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
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
      errorCode: code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : code === "EEXIST" ? "NOT_A_DIRECTORY" : "IO_ERROR",
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
