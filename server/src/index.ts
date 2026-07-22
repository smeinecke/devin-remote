import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { WsSubscriber } from "./ws-subscriber.js";
import { SessionRegistry } from "./session-registry.js";
import { handleApi, type ApiContext } from "./routes.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const PORT = Number(argValue("--port") ?? process.env.PORT ?? 7781);
const HOST = argValue("--host") ?? "127.0.0.1";
const wantOpen = args.includes("--open") || (!args.includes("--no-open") && !!process.stdout.isTTY && !process.env.SSH_CONNECTION);
const wantVersion = args.includes("--version") || args.includes("-v");
const wantHelp = args.includes("--help") || args.includes("-h");

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
) as { version: string };

if (wantVersion) {
  console.log(`devin-remote ${pkg.version}`);
  process.exit(0);
}
if (wantHelp) {
  console.log(`devin-remote — a browser console for the Devin CLI (ACP)

Usage: devin-remote [options]

Options:
  --port <port>   Port to bind (default 7781, env PORT)
  --host <host>   Host to bind (default 127.0.0.1)
  --open          Open the browser once listening
  --no-open       Do not open the browser
  --version       Print version
  --help          Show this help

Requires: devin CLI on PATH and a completed 'devin auth login'.
Data:   ~/.devin-remote (override with DEVIN_REMOTE_HOME)
Env:    DEVIN_REMOTE_ALLOWED_HOSTS — comma-separated extra hostnames allowed
        by the CSRF/DNS-rebinding guard (reverse proxies, tailnet serve, …)`);
  process.exit(0);
}

// ---- CSRF / DNS-rebinding guard --------------------------------------------
function hostParts(value: string | undefined): { host: string; port: string } | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(v);
  if (!hadScheme) v = `http://${v}`;
  try {
    const u = new URL(v);
    const port = u.port || (hadScheme ? (u.protocol === "https:" ? "443" : "80") : "");
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()]);
{
  const bound = hostParts(HOST);
  if (bound && bound.host !== "0.0.0.0" && bound.host !== "::") allowedHostnames.add(bound.host);
}
const extraAllowedHostnames = new Set<string>();
for (const extra of (process.env.DEVIN_REMOTE_ALLOWED_HOSTS ?? "").split(",")) {
  const p = hostParts(extra);
  if (p) {
    allowedHostnames.add(p.host);
    extraAllowedHostnames.add(p.host);
  }
}

function isAllowedRequest(req: http.IncomingMessage): boolean {
  const host = hostParts(req.headers.host);
  if (!host) return false;
  if (!allowedHostnames.has(host.host) && net.isIP(host.host) === 0) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const o = hostParts(String(origin));
  if (!o) return false;
  if (extraAllowedHostnames.has(o.host)) return true;
  if (o.host !== host.host) return false;
  if (host.port === "") return o.port === "80" || o.port === "443";
  return o.port === host.port;
}

// ---- devin CLI checks ------------------------------------------------------
interface DevinCheck {
  installed: boolean;
  version: string | null;
  authed: boolean;
  detail: string;
}
let cachedCheck: { at: number; result: DevinCheck } | null = null;
async function devinCheck(): Promise<DevinCheck> {
  if (cachedCheck && Date.now() - cachedCheck.at < 30_000) return cachedCheck.result;
  const result: DevinCheck = { installed: false, version: null, authed: false, detail: "" };
  try {
    const v = await execFileP("devin", ["version"], { timeout: 10_000 });
    result.installed = true;
    result.version = v.stdout.trim().split("\n")[0] ?? null;
    const s = await execFileP("devin", ["auth", "status"], { timeout: 10_000 });
    result.authed = /logged in/i.test(s.stdout);
    result.detail = s.stdout.trim();
  } catch (err) {
    result.detail = err instanceof Error ? err.message : String(err);
  }
  cachedCheck = { at: Date.now(), result };
  return result;
}

// ---- wiring ----------------------------------------------------------------
const store = new Store();
const primaryCwd = process.cwd();

const registry = new SessionRegistry({
  onEvent: (_sessionId, envelope) => {
    // Events are dispatched through the EventBus and WebSocket in WsSubscriber.
    void envelope;
  },
});

const httpServer = http.createServer();

const ws = new WsSubscriber(
  httpServer,
  registry,
  registry.eventBus,
  () => ({
    type: "config",
    app: { name: "devin-remote", version: pkg.version },
    settings: store.settings,
  }),
  { verifyOrigin: isAllowedRequest },
);

const ctx: ApiContext = {
  store,
  registry,
  ws,
  appVersion: pkg.version,
  primaryCwd,
  devinCheck,
};

// ---- static files ----------------------------------------------------------
const WEB_DIRS = [path.join(__dirname, "..", "web"), path.join(__dirname, "..", "..", "dist", "web")];
const webDir = WEB_DIRS.find((d) => fs.existsSync(path.join(d, "index.html")));
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!webDir) {
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<h1>devin-remote</h1><p>Web UI not built. Run <code>npm run build</code>, or use <code>npm run dev</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>`,
    );
    return;
  }
  let file = path.join(webDir, path.normalize(decodeURIComponent(url.pathname)));
  const rel = path.relative(webDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webDir, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  const mime = STATIC_MIME[ext] ?? "application/octet-stream";

  const send = (p: string, headers: http.OutgoingHttpHeaders) => {
    const stream = fs.createReadStream(p);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  };

  const accept = String(req.headers["accept-encoding"] ?? "");
  for (const [enc, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accept.includes(enc) && fs.existsSync(file + suffix)) {
      send(file + suffix, { "content-type": mime, "content-encoding": enc });
      return;
    }
  }
  send(file, { "content-type": mime });
}

httpServer.on("request", (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedRequest(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "forbidden origin/host — set DEVIN_REMOTE_ALLOWED_HOSTS for reverse proxies and tunnels" }),
        );
        return;
      }
      void handleApi(ctx, req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch {
    if (!res.headersSent) res.writeHead(400).end("bad request");
    else res.destroy();
  }
});

// ---- go --------------------------------------------------------------------
httpServer.listen(PORT, HOST, async () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log(`devin-remote ${pkg.version} listening on ${addr}`);
  const check = await devinCheck();
  if (!check.installed) {
    console.warn("⚠  devin CLI not found on PATH — install it first: https://docs.devin.ai/cli");
  } else if (!check.authed) {
    console.warn("⚠  devin CLI is not logged in — run: devin auth login");
  }
  if (wantOpen) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(opener, [addr], () => {});
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    registry.killAll();
    store.flush();
    process.exit(0);
  });
}
