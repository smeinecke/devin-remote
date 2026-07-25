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
    try {
      const result = await createDirectory(link, "new", roots);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
    }
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

  it("falls back to primary cwd only when env is empty", () => {
    const store = fakeStore(["/w1"]);
    const roots = getAllowedRoots("/primary", store, {});
    assert.deepStrictEqual(roots, ["/primary"]);
  });

  it("does not let stored workspaces expand the allowed-root boundary", () => {
    const store = fakeStore(["/outside"]);
    const roots = getAllowedRoots("/primary", store, {});
    assert.deepStrictEqual(roots, ["/primary"]);
    assert.ok(!roots.includes("/outside"));
  });

  it("lists only existing, readable, canonical roots and deduplicates", async () => {
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-a-"));
    const linkToA = path.join(dirs.tmp, "link-to-a");
    const missing = path.join(dirs.tmp, "missing");
    const file = path.join(dirs.tmp, "file");
    await fs.symlink(a, linkToA, "dir");
    await fs.writeFile(file, "x");

    try {
      const store = fakeStore([]);
      const primaryCwd = path.join(dirs.tmp, "primary-missing");
      const env = { DEVIN_REMOTE_WORKSPACE_ROOTS: `${linkToA},${a},${missing},${file}` };
      const roots = await listRoots(primaryCwd, store, env);
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

    const env = { DEVIN_REMOTE_WORKSPACE_ROOTS: `${dirs.root},${primary}` };
    const recent = await listRecentWorkspaces(primary, store, env);
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

    const env = { DEVIN_REMOTE_WORKSPACE_ROOTS: `${dirs.root},${primary}` };
    const recent = await listRecentWorkspaces(primary, store, env);
    assert.deepStrictEqual(recent, [primary, base]);
  });

  it("validateDirectory returns PATH_NOT_FOUND for a missing path inside a root", async () => {
    const missing = path.join(dirs.root, "does-not-exist");
    const v = await validateDirectory(missing, roots);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.exists, false);
    assert.strictEqual(v.isDirectory, false);
    assert.strictEqual(v.errorCode, "PATH_NOT_FOUND");
  });

  it("validateDirectory returns NOT_A_DIRECTORY for an existing file", async () => {
    const file = path.join(dirs.root, "readme.txt");
    const v = await validateDirectory(file, roots);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.exists, true);
    assert.strictEqual(v.isDirectory, false);
    assert.strictEqual(v.errorCode, "NOT_A_DIRECTORY");
  });

  it("createDirectory returns PATH_ALREADY_EXISTS for an existing directory", async () => {
    const existing = path.join(dirs.root, "shared");
    const result = await createDirectory(dirs.root, "shared", roots);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isDirectory, true);
    assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
  });

  it("createDirectory returns PATH_ALREADY_EXISTS for an existing file", async () => {
    await fs.writeFile(path.join(dirs.root, "new-file"), "x");
    try {
      const result = await createDirectory(dirs.root, "new-file", roots);
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.isDirectory, false);
      assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    } finally {
      await fs.rm(path.join(dirs.root, "new-file"), { force: true });
    }
  });

  it("createDirectory returns PATH_ALREADY_EXISTS for a symlink to an existing directory", async () => {
    const existing = path.join(dirs.root, "shared");
    const link = path.join(dirs.root, "shared-link");
    await fs.symlink(existing, link, "dir");
    try {
      const result = await createDirectory(dirs.root, "shared-link", roots);
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.isDirectory, true);
      assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("createDirectory preserves SYMLINK_ESCAPE for an existing symlink that escapes", async () => {
    const link = path.join(dirs.root, "escape-to-outside");
    await fs.symlink(dirs.outside, link, "dir");
    try {
      const result = await createDirectory(dirs.root, "escape-to-outside", roots);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("recent paths outside trusted roots do not become trusted roots", () => {
    const store = fakeStore([dirs.outside]);
    const roots = getAllowedRoots(dirs.root, store, {});
    assert.deepStrictEqual(roots, [dirs.root]);
    assert.ok(!roots.includes(dirs.outside));
  });

  it("changing configured roots removes incompatible recent entries from the picker", async () => {
    const primary = path.join(dirs.tmp, "primary");
    const inside = path.join(dirs.root, "inside");
    await fs.mkdir(primary, { recursive: true });
    await fs.mkdir(inside, { recursive: true });

    const store = {
      workspaces: () => [inside, primary],
      sessions: () => ({}),
      setWorkspaces: () => {},
    } as any;

    // When only primary is trusted, the entry inside dirs.root is omitted.
    const recentPrimaryOnly = await listRecentWorkspaces(primary, store, {});
    assert.deepStrictEqual(recentPrimaryOnly, [primary]);

    // Adding dirs.root as an explicit root restores the other entry.
    const recentBoth = await listRecentWorkspaces(primary, store, {
      DEVIN_REMOTE_WORKSPACE_ROOTS: `${primary},${dirs.root}`,
    });
    assert.deepStrictEqual(recentBoth, [primary, inside]);
  });

  it("legacy store entries cannot expand browsing scope", async () => {
    const outside = path.join(dirs.tmp, "outside-workspace");
    await fs.mkdir(outside, { recursive: true });

    const store = {
      workspaces: () => [outside],
      sessions: () => ({}),
      setWorkspaces: (w: string[]) => {},
    } as any;

    const roots = getAllowedRoots(dirs.root, store, {});
    const listing = await listDirectories(outside, roots);
    assert.strictEqual(listing.allowed, false);
    assert.strictEqual(listing.errorCode, "OUTSIDE_ALLOWED_ROOT");
  });

  it("revalidates a race-created contained directory as PATH_ALREADY_EXISTS", async () => {
    const name = "race-dir";
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.mkdir(p);
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    const stat = await fs.stat(target);
    assert.ok(stat.isDirectory());
  });

  it("revalidates a race-created contained file as PATH_ALREADY_EXISTS", async () => {
    const name = "race-file";
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.writeFile(p, "x");
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    const stat = await fs.stat(target);
    assert.ok(stat.isFile());
  });

  it("revalidates a race-created contained symlink as PATH_ALREADY_EXISTS", async () => {
    const name = "race-link";
    const existing = path.join(dirs.root, "existing-dir");
    await fs.mkdir(existing);
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.symlink(existing, p, "dir");
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    const resolved = await fs.realpath(target);
    assert.strictEqual(resolved, existing);
  });

  it("revalidates a race-created escaping symlink as SYMLINK_ESCAPE", async () => {
    const name = "race-escape";
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.symlink(dirs.outside, p, "dir");
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "SYMLINK_ESCAPE");
  });

  it("returns PERMISSION_DENIED when EEXIST revalidation cannot inspect the target", async () => {
    const name = "race-no-access";
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.mkdir(p);
          await fs.chmod(p, 0o000);
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    try {
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.errorCode, "PERMISSION_DENIED");
    } finally {
      await fs.chmod(target, 0o755).catch(() => {});
    }
  });

  it("classifies a contained symlink to outside as SYMLINK_ESCAPE", async () => {
    const link = path.join(dirs.root, "escape");
    await fs.symlink(dirs.outside, link, "dir");
    try {
      const v = await validateDirectory(link, roots);
      assert.strictEqual(v.allowed, false);
      assert.strictEqual(v.errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("classifies a symlink path outside every root as OUTSIDE_ALLOWED_ROOT", async () => {
    const outsideLink = path.join(dirs.outside, "link-to-root");
    await fs.symlink(dirs.root, outsideLink, "dir");
    try {
      const v = await validateDirectory(outsideLink, roots);
      assert.strictEqual(v.allowed, false);
      assert.strictEqual(v.errorCode, "OUTSIDE_ALLOWED_ROOT");
    } finally {
      await fs.rm(outsideLink, { force: true });
    }
  });

  it("classifies a plain outside path as OUTSIDE_ALLOWED_ROOT", async () => {
    const v = await validateDirectory(dirs.outside, roots);
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.errorCode, "OUTSIDE_ALLOWED_ROOT");
  });

  it("classifies a contained symlink to a contained directory as allowed", async () => {
    const target = path.join(dirs.root, "real-subdir");
    const link = path.join(dirs.root, "link-to-subdir");
    await fs.mkdir(target);
    await fs.symlink(target, link, "dir");
    try {
      const v = await validateDirectory(link, roots);
      assert.strictEqual(v.allowed, true);
      assert.strictEqual(v.isDirectory, true);
      assert.strictEqual(v.resolvedPath, target);
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("returns DANGLING_SYMLINK for a contained dangling symlink", async () => {
    const link = path.join(dirs.root, "dangling");
    await fs.symlink(path.join(dirs.root, "missing-child"), link, "dir");
    try {
      const v = await validateDirectory(link, roots);
      assert.strictEqual(v.allowed, true);
      assert.strictEqual(v.exists, true);
      assert.strictEqual(v.isDirectory, false);
      assert.strictEqual(v.errorCode, "DANGLING_SYMLINK");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("createDirectory returns PATH_ALREADY_EXISTS for a dangling contained symlink", async () => {
    const link = path.join(dirs.root, "dangling-contained");
    await fs.symlink(path.join(dirs.root, "missing-child"), link, "dir");
    try {
      const result = await createDirectory(dirs.root, "dangling-contained", roots);
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.errorCode, "PATH_ALREADY_EXISTS");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("createDirectory returns SYMLINK_ESCAPE for a dangling escaping symlink", async () => {
    const link = path.join(dirs.root, "dangling-escape");
    await fs.symlink(path.join(dirs.outside, "missing"), link, "dir");
    try {
      const result = await createDirectory(dirs.root, "dangling-escape", roots);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("revalidates a race-created dangling escaping symlink as SYMLINK_ESCAPE", async () => {
    const name = "race-dangling-escape";
    const target = path.join(dirs.root, name);
    const result = await createDirectory(dirs.root, name, roots, {
      deps: {
        mkdir: async (p: string) => {
          await fs.symlink(path.join(dirs.outside, "missing"), p, "dir");
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "SYMLINK_ESCAPE");
    await fs.rm(target, { force: true });
  });
});
