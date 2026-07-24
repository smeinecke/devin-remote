import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  getAllowedRoots,
  isWithinRoot,
  listDirectories,
  validateDirectory,
  createDirectory,
  rootLabel,
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
    assert.deepStrictEqual(names, [".hidden", "projects", "shared"]);
    assert.ok(!listing.entries.some((e) => e.name === "readme.txt"));
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

  it("filters hidden directories by default", async () => {
    const listing = await listDirectories(dirs.root, roots);
    const hidden = listing.entries.filter((e) => e.hidden);
    assert.strictEqual(hidden.length, 1);
    assert.strictEqual(hidden[0].name, ".hidden");
  });

  it("creates a directory inside an allowed root", async () => {
    const target = path.join(dirs.root, "new-project");
    const result = await createDirectory(target, roots);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.isDirectory, true);
    const stat = await fs.stat(target);
    assert.ok(stat.isDirectory());
  });

  it("rejects invalid folder names", async () => {
    const result = await createDirectory(`${dirs.root}${path.sep}bad\0dir`, roots);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.errorCode, "INVALID_PATH");
  });

  it("rejects directory creation outside allowed roots", async () => {
    const target = path.join(dirs.outside, "new");
    const result = await createDirectory(target, roots);
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
    const listing = await listDirectories(dirs.root, roots);
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
});
