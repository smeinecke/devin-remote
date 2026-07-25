import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Store } from "../src/store.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WsSubscriber } from "../src/ws-subscriber.js";
import { handleApi } from "../src/routes.js";

describe("filesystem route integration", () => {
  let tmp: string;
  let root: string;
  let primaryCwd: string;
  let server: http.Server;
  let port: number;
  let store: Store;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "routes-test-"));
    root = path.join(tmp, "root");
    primaryCwd = root;
    await fs.mkdir(path.join(root, "projects"), { recursive: true });
    await fs.writeFile(path.join(root, "readme.txt"), "hello");

    process.env.DEVIN_REMOTE_HOME = path.join(tmp, "home");
    store = new Store();

    const registry = new SessionRegistry();
    const httpServer = http.createServer();
    const ws = new WsSubscriber(
      httpServer,
      registry,
      registry.eventBus,
      () => ({ type: "config" as const, app: { name: "devin-remote", version: "test" }, settings: {} }),
    );

    const ctx = {
      store,
      registry,
      ws,
      appVersion: "test",
      primaryCwd,
      devinCheck: async () => ({ installed: false, version: null, authed: false, detail: "" }),
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      void handleApi(ctx, req, res, url);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
          resolve();
        } else {
          reject(new Error("could not get server port"));
        }
      });
      server.once("error", reject);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.flush();
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.DEVIN_REMOTE_HOME;
  });

  async function request(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // Non-JSON response.
    }
    return { status: res.status, body: payload };
  }

  it("POST /api/filesystem/validate-directory missing allowed-root child returns 404 PATH_NOT_FOUND", async () => {
    const target = path.join(root, "missing");
    const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: target });
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).errorCode, "PATH_NOT_FOUND");
  });

  it("POST /api/filesystem/validate-directory returns 400 NOT_A_DIRECTORY for a file", async () => {
    const target = path.join(root, "readme.txt");
    const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: target });
    assert.strictEqual(status, 400);
    assert.strictEqual((body as any).errorCode, "NOT_A_DIRECTORY");
  });

  it("POST /api/filesystem/validate-directory returns 200 for an existing directory", async () => {
    const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: root });
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).allowed, true);
    assert.strictEqual((body as any).exists, true);
    assert.strictEqual((body as any).isDirectory, true);
  });

  it("POST /api/filesystem/create-directory existing directory returns 409 PATH_ALREADY_EXISTS", async () => {
    const { status, body } = await request("POST", "/api/filesystem/create-directory", {
      parentPath: root,
      name: "projects",
    });
    assert.strictEqual(status, 409);
    assert.strictEqual((body as any).errorCode, "PATH_ALREADY_EXISTS");
  });

  it("POST /api/filesystem/create-directory existing file returns 409 PATH_ALREADY_EXISTS", async () => {
    await fs.writeFile(path.join(root, "new-file"), "x");
    try {
      const { status, body } = await request("POST", "/api/filesystem/create-directory", {
        parentPath: root,
        name: "new-file",
      });
      assert.strictEqual(status, 409);
      assert.strictEqual((body as any).errorCode, "PATH_ALREADY_EXISTS");
    } finally {
      await fs.rm(path.join(root, "new-file"), { force: true });
    }
  });

  it("POST /api/sessions missing workspace returns 404 PATH_NOT_FOUND", async () => {
    const target = path.join(root, "missing");
    const { status, body } = await request("POST", "/api/sessions", { cwd: target, mode: "" });
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).validation.errorCode, "PATH_NOT_FOUND");
  });

  it("POST /api/sessions outside workspace root returns 403", async () => {
    const outside = path.join(tmp, "outside");
    const { status, body } = await request("POST", "/api/sessions", { cwd: outside, mode: "" });
    assert.strictEqual(status, 403);
    assert.ok((body as any).validation.errorCode);
  });

  it("GET /api/filesystem/recent omits entries outside trusted roots", async () => {
    store.addWorkspace(root);
    store.addWorkspace(path.join(tmp, "outside-recent"));
    const { status, body } = await request("GET", "/api/filesystem/recent");
    assert.strictEqual(status, 200);
    const recent = (body as any).recent as string[];
    assert.ok(recent.includes(root), "root should appear in recent");
    assert.ok(!recent.some((p) => p.includes("outside-recent")), "outside path should not appear");
  });

  it("POST /api/filesystem/create-directory existing escaping symlink returns 403 SYMLINK_ESCAPE", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside, { recursive: true });
    const link = path.join(root, "escape-link");
    await fs.symlink(outside, link, "dir");
    try {
      const { status, body } = await request("POST", "/api/filesystem/create-directory", {
        parentPath: root,
        name: "escape-link",
      });
      assert.strictEqual(status, 403);
      assert.strictEqual((body as any).errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("POST /api/filesystem/validate-directory includeGit=false returns no git metadata", async () => {
    const { status, body } = await request("POST", "/api/filesystem/validate-directory", {
      path: root,
      includeGit: false,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).gitRepository, false);
    assert.strictEqual((body as any).branch, null);
  });

  it("POST /api/filesystem/validate-directory default still permits git metadata", async () => {
    const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: root });
    assert.strictEqual(status, 200);
    assert.strictEqual(typeof (body as any).gitRepository, "boolean");
  });

  it("POST /api/filesystem/validate-directory symlink outside roots returns 403 OUTSIDE_ALLOWED_ROOT", async () => {
    const outside = path.join(tmp, "outside-with-link");
    const outsideLink = path.join(outside, "link-to-root");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(root, outsideLink, "dir");
    try {
      const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: outsideLink });
      assert.strictEqual(status, 403);
      assert.strictEqual((body as any).errorCode, "OUTSIDE_ALLOWED_ROOT");
    } finally {
      await fs.rm(outsideLink, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("POST /api/filesystem/validate-directory contained escaping symlink returns 403 SYMLINK_ESCAPE", async () => {
    const outside = path.join(tmp, "outside-escape");
    await fs.mkdir(outside, { recursive: true });
    const link = path.join(root, "escape-link");
    await fs.symlink(outside, link, "dir");
    try {
      const { status, body } = await request("POST", "/api/filesystem/validate-directory", { path: link });
      assert.strictEqual(status, 403);
      assert.strictEqual((body as any).errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("POST /api/filesystem/create-directory dangling contained symlink returns 409 PATH_ALREADY_EXISTS", async () => {
    const link = path.join(root, "dangling-contained");
    await fs.symlink(path.join(root, "missing-child"), link, "dir");
    try {
      const { status, body } = await request("POST", "/api/filesystem/create-directory", {
        parentPath: root,
        name: "dangling-contained",
      });
      assert.strictEqual(status, 409);
      assert.strictEqual((body as any).errorCode, "PATH_ALREADY_EXISTS");
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("POST /api/filesystem/create-directory dangling escaping symlink returns 403 SYMLINK_ESCAPE", async () => {
    const outside = path.join(tmp, "outside-dangling");
    await fs.mkdir(outside, { recursive: true });
    const link = path.join(root, "dangling-escape");
    await fs.symlink(path.join(outside, "missing"), link, "dir");
    try {
      const { status, body } = await request("POST", "/api/filesystem/create-directory", {
        parentPath: root,
        name: "dangling-escape",
      });
      assert.strictEqual(status, 403);
      assert.strictEqual((body as any).errorCode, "SYMLINK_ESCAPE");
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
