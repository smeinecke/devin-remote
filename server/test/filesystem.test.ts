import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  getAllowedRoots,
  isWithinRoot,
  listDirectories,
  listRoots,
  validateDirectory,
  createDirectory,
  rootLabel,
  checkWorkspaceForMode,
  listRecentWorkspaces,
} from "../src/filesystem.js";

function fakeStore(workspaces: string[] = []) {
  return { workspaces: () => workspaces } as any;
}

async function makeFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-test-"));
  const root = path.join(tmp, "root");
  const nested = path.join(root, "projects", "devin-remote");
  const outside = path.join(tmp, "outside");
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(root, "shared"));
  await fs.writeFile(path.join(root, "readme.txt"), "hello");
  await fs.mkdir(path.join(root, ".hidden"));
  await fs.mkdir(path.join(nested, "packages"));
  return { tmp, root, nested, outside };
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("filesystem API", () => {
  let dirs: Awaited<ReturnType<typeof makeFixture>>;
  let roots: string[] = [];

  beforeEach(async () => {
    dirs = await makeFixture();
    roots = [dirs.root];
  });

  afterEach(async () => {
    await cleanup(dirs.tmp);
  });

  it("lists an allowed directory with only child directories", async () => {
    const listing = await listDirectories(dirs.root, roots);
    assert.strictEqual(listing.allowed, true);
    assert.strictEqual(listing.errorCode, undefined);
    const names = listing.entries.map((e) => e.name).sort();
    assert.deepStrictEqual(names, ["projects", "shared"]);
    assert.ok(!listing.entries.some((e) => e.name === "readme.txt"));
  });

  it("excludes hidden directories by default", async () => {
    const listing = await listDirectories(dirs.root, roots);
    assert.ok(!listing.entries.some((e) => e.name === ".hidden"));
  });

  it("includes hidden directories when showHidden is true", async () => {
    const listing = await listDirectories(dirs.root, roots, true);
    const names = listing.entries.map((e) => e.name).sort();
    assert.deepStrictEqual(names, [".hidden", "projects", "shared"]);
  });

  it("rejects path traversal", async () => {
    const target = path.join(dirs.root, "..", "outside");
    const listing = await listDirectories(target, roots);
    assert.strictEqual(listing.allowed, false);
    assert.strictEqual(listing.errorCode, "OUTSIDE_ALLOWED_ROOT");
  });

  it("rejects symlink escape", async () => {
    const escapeLink = path.join(dirs.root, "escape");
    await fs.symlink(dirs.outside, escapeLink, "dir");
    const listing = await listDirectories(escapeLink, roots);
    assert.strictEqual(listing.allowed, false);
    assert.strictEqual(listing.errorCode, "SYMLINK_ESCAPE");
  });

  it("returns missing path for a directory outside roots", async () => {
    const listing = await listDirectories(path.join(dirs.outside, "nope"), roots);
    assert.strictEqual(listing.allowed, false);
    assert.strictEqual(listing.errorCode, "OUTSIDE_ALLOWED_ROOT");
  });

  it("returns PATH_NOT_FOUND for a missing directory inside roots", async () => {
    const listing = await listDirectories(path.join(dirs.root, "nope"), roots);
    assert.strictEqual(listing.allowed, true);
    assert.strictEqual(listing.errorCode, "PATH_NOT_FOUND");
  });

  it("returns NOT_A_DIRECTORY when a file is passed", async () => {
    const file = path.join(dirs.root, "readme.txt");
    const listing = await listDirectories(file, roots);
    assert.strictEqual(listing.allowed, true);
    assert.strictEqual(listing.errorCode, "NOT_A_DIRECTORY");
  });

  it("reports current directory writability", async () => {
    const listing = await listDirectories(dirs.root, roots);
    assert.strictEqual(listing.writable, true);
  });

  it("creates a directory inside an allowed root", async () => {
    const target = path.join(dirs.root, "new-project");
    const result = await createDirectory(dirs.root, "new-project", roots);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isDirectory, true);
    const stat = await fs.stat(target);
    assert.ok(stat.isDirectory());
  });

  it("creates a directory through a normalised parent path", async () => {
    const parent = path.join(dirs.root, "projects", "..");
    const result = await createDirectory(parent, "new-project", roots);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isDirectory, true);
    const createdAt = path.join(dirs.root, "new-project");
    const stat = await fs.stat(createdAt);
    assert.ok(stat.isDirectory());
  });

  it("creates a directory through a symlink parent inside the root", async () => {
    const subdir = path.join(dirs.root, "subdir");
    const link = path.join(dirs.root, "link");
    await fs.mkdir(subdir);
    await fs.symlink(subdir, link, "dir");
    const result = await createDirectory(link, "new", roots);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isDirectory, true);
    const stat = await fs.stat(path.join(subdir, "new"));
    assert.ok(stat.isDirectory());
  });

  it("rejects creating a directory through a symlink parent that escapes", async () => {
    const link = path.join(dirs.root, "escape-link");
    await fs.symlink(dirs.outside, link, "dir");
    const result = await createDirectory(link, "new", roots);
    assert.strictEqual(result.allowed, false);
    assert.ok(
      result.errorCode === "SYMLINK_ESCAPE" || result.errorCode === "OUTSIDE_ALLOWED_ROOT",
      `unexpected error code: ${result.errorCode}`,
    );
  });

  it("rejects invalid folder names", async () => {
    const result = await createDirectory(dirs.root, `bad\0dir`, roots);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "INVALID_PATH");
  });

  it("rejects directory creation outside allowed roots", async () => {
    const result = await createDirectory(dirs.outside, "new", roots);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "OUTSIDE_ALLOWED_ROOT");
  });

  it("validates canonical recent paths", async () => {
    const v = await validateDirectory(dirs.nested, roots);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.exists, true);
    assert.strictEqual(v.isDirectory, true);
    assert.strictEqual(v.readable, true);
  });

  it("rejects stale or invalid recent paths", async () => {
    const v = await validateDirectory(path.join(dirs.outside, "old"), roots);
    assert.strictEqual(v.allowed, false);
  });

  it("supports multiple configured roots", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "fs-other-"));
    try {
      const multiRoots = [dirs.root, other];
      const listing = await listDirectories(other, multiRoots);
      assert.strictEqual(listing.allowed, true);
    } finally {
      await cleanup(other);
    }
  });

  it("handles unicode and spaces in paths", async () => {
    const target = path.join(dirs.root, "unicode 目录 🗂️");
    await fs.mkdir(target);
    const listing = await listDirectories(target, roots);
    assert.strictEqual(listing.allowed, true);
    assert.strictEqual(listing.errorCode, undefined);
  });

  it("only returns child directories, not files", async () => {
    const listing = await listDirectories(dirs.root, roots, true);
    for (const e of listing.entries) {
      const stat = await fs.stat(e.path);
      assert.ok(stat.isDirectory(), `${e.name} is not a directory`);
    }
  });

  it("reports isWithinRoot correctly", () => {
    assert.strictEqual(isWithinRoot("/a/b", "/a/b"), true);
    assert.strictEqual(isWithinRoot("/a/b", "/a/b/c"), true);
    assert.strictEqual(isWithinRoot("/a/b", "/a/c"), false);
    assert.strictEqual(isWithinRoot("/a/b", "/a"), false);
  });

  it("computes root labels", () => {
    assert.strictEqual(rootLabel(path.join(os.homedir(), "projects")), "~/projects");
    assert.strictEqual(rootLabel("/srv/workspaces"), "workspaces");
  });

  it("uses DEVIN_REMOTE_WORKSPACE_ROOTS when set", () => {
    const store = fakeStore(["/ignored"]);
    const roots = getAllowedRoots("/primary", store, { DEVIN_REMOTE_WORKSPACE_ROOTS: "/a,/b" });
    assert.deepStrictEqual(roots, ["/a", "/b"]);
  });

  it("falls back to primary cwd and stored workspaces when env is empty", () => {
    const store = fakeStore(["/w1"]);
    const roots = getAllowedRoots("/primary", store, {});
    assert.deepStrictEqual(roots, ["/primary", "/w1"]);
  });

  it("lists only existing, readable, canonical roots and deduplicates", async () => {
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-a-"));
    const linkToA = path.join(dirs.tmp, "link-to-a");
    const missing = path.join(dirs.tmp, "missing");
    const file = path.join(dirs.tmp, "file");
    await fs.symlink(a, linkToA, "dir");
    await fs.writeFile(file, "x");

    try {
      const store = fakeStore([linkToA, a, missing, file]);
      // Use a nonexistent primary cwd so the only configured roots are the
      // workspace list, which should collapse to one canonical root.
      const primaryCwd = path.join(dirs.tmp, "primary-missing");
      const roots = await listRoots(primaryCwd, store, {});
      const paths = roots.map((r) => r.path);
      assert.strictEqual(paths.length, 1);
      assert.ok(paths[0].startsWith(a), `expected canonical path for ${a}, got ${paths[0]}`);
    } finally {
      await fs.rm(a, { recursive: true, force: true });
    }
  });

  it("reports a read-only directory as writable=false", async () => {
    const roDir = path.join(dirs.tmp, "readonly");
    await fs.mkdir(roDir);
    await fs.chmod(roDir, 0o555);
    try {
      const listing = await listDirectories(roDir, [roDir]);
      assert.strictEqual(listing.writable, false);
      const v = await validateDirectory(roDir, [roDir]);
      assert.strictEqual(v.writable, false);
      assert.strictEqual(v.readable, true);
    } finally {
      await fs.chmod(roDir, 0o755);
    }
  });

  it("checkWorkspaceForMode respects mode and isolation", () => {
    const writable: any = { allowed: true, exists: true, isDirectory: true, readable: true, writable: true };
    const readonly: any = { allowed: true, exists: true, isDirectory: true, readable: true, writable: false };
    const invalid: any = { allowed: false, exists: false, isDirectory: false, readable: false, writable: false };

    assert.strictEqual(checkWorkspaceForMode(writable, "ask").allowed, true);
    assert.strictEqual(checkWorkspaceForMode(readonly, "ask").allowed, true);
    assert.strictEqual(checkWorkspaceForMode(writable, "accept-edits").allowed, true);
    assert.strictEqual(checkWorkspaceForMode(readonly, "accept-edits").allowed, false);
    assert.strictEqual(checkWorkspaceForMode(readonly, "plan").allowed, false);
    assert.strictEqual(checkWorkspaceForMode(readonly, "ask", true).allowed, false);
    assert.strictEqual(checkWorkspaceForMode(invalid, "ask").allowed, false);
  });

  it("returns the matched root and breadcrumbs for an allowed directory", async () => {
    const listing = await listDirectories(dirs.nested, roots);
    assert.strictEqual(listing.allowed, true);
    assert.ok(listing.root);
    assert.strictEqual(listing.root.path, dirs.root);
    assert.strictEqual(listing.root.label, rootLabel(dirs.root));
    assert.deepStrictEqual(listing.breadcrumbs, [
      { label: path.basename(dirs.root), path: dirs.root },
      { label: "projects", path: path.join(dirs.root, "projects") },
      { label: "devin-remote", path: dirs.nested },
    ]);
  });

  it("chooses the longest overlapping root", async () => {
    const nestedRoot = dirs.nested;
    const multiRoots = [dirs.root, nestedRoot];
    const target = path.join(dirs.nested, "packages");
    const listing = await listDirectories(target, multiRoots);
    assert.strictEqual(listing.allowed, true);
    assert.strictEqual(listing.root.path, nestedRoot);
    assert.deepStrictEqual(listing.breadcrumbs, [
      { label: path.basename(nestedRoot), path: nestedRoot },
      { label: "packages", path: target },
    ]);
  });

  it("breadcrumbs never contain paths outside the matched root", async () => {
    const nestedRoot = dirs.nested;
    const multiRoots = [dirs.root, nestedRoot];
    const target = path.join(dirs.nested, "packages");
    const listing = await listDirectories(target, multiRoots);
    for (const crumb of listing.breadcrumbs) {
      assert.ok(
        isWithinRoot(listing.root.path, crumb.path),
        `breadcrumb ${crumb.path} is outside root ${listing.root.path}`,
      );
    }
  });

  it("recent workspaces are canonical, deduplicated, and exclude generated worktrees", async () => {
    const primary = path.join(dirs.tmp, "primary");
    const base = path.join(dirs.root, "base");
    const linkToBase = path.join(dirs.tmp, "link-to-base");
    const worktree = path.join(dirs.tmp, "worktree");
    const file = path.join(dirs.tmp, "file");
    const missing = path.join(dirs.tmp, "missing");
    await fs.mkdir(primary, { recursive: true });
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.symlink(base, linkToBase, "dir");
    await fs.writeFile(file, "x");

    const setWorkspaces: string[] = [];
    const store = {
      workspaces: () => [linkToBase, base, missing, file, primary],
      sessions: () => ({
        s1: { cwd: worktree, worktree, updatedAt: "2026-01-01T00:00:00Z" },
        s2: { cwd: base, worktree: null, updatedAt: "2026-01-02T00:00:00Z" },
      }),
      setWorkspaces: (w: string[]) => setWorkspaces.push(...w),
    } as any;

    const recent = await listRecentWorkspaces(primary, store, { DEVIN_REMOTE_WORKSPACE_ROOTS: "" });
    assert.deepStrictEqual(recent, [primary, base]);
    assert.deepStrictEqual(setWorkspaces, [base, primary]);
  });

  it("returns parent=null at the exact matched root and a parent inside the matched root", async () => {
    const nestedRoot = dirs.nested;
    const multiRoots = [dirs.root, nestedRoot];

    const atNested = await listDirectories(nestedRoot, multiRoots);
    assert.strictEqual(atNested.allowed, true);
    assert.strictEqual(atNested.root.path, nestedRoot);
    assert.strictEqual(atNested.parent, null);

    const child = path.join(nestedRoot, "packages");
    const atChild = await listDirectories(child, multiRoots);
    assert.strictEqual(atChild.allowed, true);
    assert.strictEqual(atChild.root.path, nestedRoot);
    assert.strictEqual(atChild.parent, nestedRoot);
    assert.ok(atChild.parent && isWithinRoot(nestedRoot, atChild.parent));
  });

  it("prevents parent navigation from leaving the matched nested root", async () => {
    const nestedRoot = dirs.nested;
    const multiRoots = [dirs.root, nestedRoot];
    const target = path.join(nestedRoot, "packages");
    const listing = await listDirectories(target, multiRoots);

    assert.strictEqual(listing.parent, nestedRoot);
    if (listing.parent) {
      const up = await listDirectories(listing.parent, multiRoots);
      assert.strictEqual(up.root.path, nestedRoot);
      assert.strictEqual(up.parent, null);
    }
  });

  it("rejects create-directory names containing separators", async () => {
    const result = await createDirectory(dirs.root, "a/b", roots);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "INVALID_PATH");
  });

  it("rejects create-directory name '..'", async () => {
    const result = await createDirectory(dirs.root, "..", roots);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "INVALID_PATH");
  });

  it("returns structured error bodies for disallowed listings", async () => {
    const listing = await listDirectories(dirs.outside, roots);
    assert.strictEqual(listing.allowed, false);
    assert.ok(listing.errorCode);
    assert.strictEqual(typeof listing.path, "string");
    assert.ok(Array.isArray(listing.entries));
  });

  it("validateDirectory with includeGit=false never returns git metadata", async () => {
    const v = await validateDirectory(dirs.root, roots, { includeGit: false });
    assert.strictEqual(v.gitRepository, false);
    assert.strictEqual(v.branch, null);
  });

  it("validateDirectory with includeGit=true can return git metadata when available", async () => {
    // If git is unavailable or this is not a repo, it should still be safe.
    const v = await validateDirectory(dirs.root, roots, { includeGit: true });
    assert.strictEqual(typeof v.gitRepository, "boolean");
    assert.strictEqual(v.allowed, true);
  });

  it("recent-workspace cleanup does not need git metadata", async () => {
    const primary = path.join(dirs.tmp, "primary");
    const base = path.join(dirs.root, "base");
    await fs.mkdir(primary, { recursive: true });
    await fs.mkdir(base, { recursive: true });

    const store = {
      workspaces: () => [base, primary],
      sessions: () => ({}),
      setWorkspaces: () => {},
    } as any;

    const recent = await listRecentWorkspaces(primary, store, { DEVIN_REMOTE_WORKSPACE_ROOTS: "" });
    assert.deepStrictEqual(recent, [primary, base]);
  });
});
