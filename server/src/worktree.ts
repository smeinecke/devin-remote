/**
 * Git worktree isolation for concurrent sessions.
 *
 * - Detects whether `cwd` is inside a Git repository.
 * - Creates a dedicated worktree + branch under `.devin-remote/worktrees/`.
 * - Sanitizes session-derived names and prevents path traversal.
 * - Refuses to delete worktrees with uncommitted changes.
 */

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface WorktreeInfo {
  root: string;
  worktree: string;
  branch: string;
  isIsolated: boolean;
  /** Base commit the branch was created from, when isolated. */
  baseCommit?: string;
}

function sanitize(input: string): string {
  // Keep only safe filesystem characters; no leading dots or slashes.
  return input
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40) || "session";
}

export async function findGitRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function isGitRepository(dir: string): Promise<boolean> {
  const root = await findGitRoot(dir);
  return root !== null;
}

export async function createWorktree(
  sessionId: string,
  baseCwd: string,
): Promise<WorktreeInfo> {
  const root = await findGitRoot(baseCwd);
  if (!root) {
    return { root: baseCwd, worktree: baseCwd, branch: "", isIsolated: false, baseCommit: "" };
  }

  const base = sanitize(path.basename(root));
  const suffix = sanitize(sessionId) + "-" + randomBytes(8).toString("hex");
  const branch = `devin-remote/${base}/${suffix}`;
  const worktreesDir = path.join(root, ".devin-remote", "worktrees");
  const worktree = path.join(worktreesDir, suffix + "-" + randomUUID().slice(0, 8));

  // Ensure the worktree path is under the repo root.
  const rel = path.relative(root, worktree);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("worktree path escapes repository root");
  }

  await fs.mkdir(worktreesDir, { recursive: true });

  // Resolve the base revision from the requested cwd, not the root worktree HEAD.
  const { stdout: headOut } = await execFileP("git", ["-C", baseCwd, "rev-parse", "HEAD"], { timeout: 10_000 });
  const baseCommit = headOut.trim();

  await execFileP("git", ["-C", root, "worktree", "add", "-b", branch, worktree, baseCommit], { timeout: 30_000 });

  return { root, worktree, branch, isIsolated: true, baseCommit };
}

export async function cleanupWorktree(worktree: string): Promise<void> {
  const root = await findGitRoot(worktree);
  if (!root) return;

  // Safety: refuse to remove worktree with uncommitted changes.
  const { stdout } = await execFileP("git", ["-C", worktree, "status", "--porcelain"], { timeout: 10_000 });
  if (stdout.trim()) {
    throw new Error("worktree has uncommitted changes; remove it manually");
  }

  await execFileP("git", ["-C", root, "worktree", "remove", worktree], { timeout: 30_000 });
}

/**
 * Roll back a worktree that was just created and never used. Removes the
 * worktree and deletes its branch only if the branch still points to the
 * original base commit.
 */
export async function rollbackCreatedWorktree(info: WorktreeInfo): Promise<void> {
  if (!info.isIsolated || !info.baseCommit) return;

  await cleanupWorktree(info.worktree).catch((err) => console.error("rollback cleanup failed:", err));

  try {
    const { stdout } = await execFileP("git", ["-C", info.root, "rev-parse", info.branch], { timeout: 10_000 });
    if (stdout.trim() === info.baseCommit) {
      await execFileP("git", ["-C", info.root, "branch", "-D", info.branch], { timeout: 10_000 });
    }
  } catch {
    // Branch may already be gone; ignore.
  }
}

export async function listWorktrees(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 10_000 });
    const out: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        out.push(line.slice("worktree ".length).trim());
      }
    }
    return out;
  } catch {
    return [];
  }
}
