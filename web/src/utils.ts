// Small shared helpers — time, numbers, fuzzy match, line diff.

/** Generate a UUID v4, falling back for non-secure (`http://`) contexts. */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Produce a compact plain-text preview from reasoning content.
 * Collapses whitespace, removes Markdown heading/blockquote markers, replaces
 * fenced code blocks with a marker, and only appends an ellipsis when truncated.
 */
export function makeReasoningPreview(text: string, maxLength = 220): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return "";
  if (compact.length <= maxLength) return compact;

  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export interface WorkspaceSession {
  cwd?: string;
  worktree?: string | null;
}

/**
 * Strip generated worktree / cwd prefixes from an absolute path so compact rows
 * show repository-relative paths. Falls back to the original (or basename) when
 * no prefix matches. Also accepts `file://` URIs.
 */
export function shortenWorkspacePath(p: string, session?: WorkspaceSession | null): string {
  if (!p) return "";
  let clean = p;
  if (clean.startsWith("file:///")) clean = clean.slice(7);
  else if (clean.startsWith("file://")) clean = clean.slice(6);
  clean = clean.replace(/\\/g, "/").replace(/\/+/g, "/");

  const candidates = [session?.worktree, session?.cwd].filter((b): b is string => Boolean(b));
  for (const base of candidates) {
    const b = base.replace(/\/+$/, "");
    if (clean === b) return "";
    if (clean.startsWith(`${b}/`)) {
      const rel = clean.slice(b.length + 1);
      return rel || basename(clean);
    }
  }

  return clean;
}

export interface ToolCallLike {
  kind: string;
  title: string;
  rawInput?: unknown;
  content?: Array<{ type?: string; path?: string }>;
  locations?: Array<{ path?: string }>;
}

function joinCommand(cmd: unknown, args: unknown): string {
  const parts: string[] = [];
  if (typeof cmd === "string") parts.push(cmd);
  if (Array.isArray(args)) {
    for (const a of args) {
      if (typeof a === "string") parts.push(a);
    }
  }
  return parts.join(" ");
}

function looksLikePath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[a-zA-Z]:[/\\]/.test(s);
}

/**
 * Derive a compact primary label for a tool call row.
 * Prefers concrete input (command, path, query) over generic titles, and strips
 * absolute worktree prefixes from displayed paths.
 */
export function toolCallPrimaryLabel(call: ToolCallLike, session?: WorkspaceSession | null): string {
  const fallback = call.title || call.kind || "tool";

  // 1. raw input
  if (call.rawInput != null) {
    if (typeof call.rawInput === "string") {
      const t = call.rawInput.trim();
      if (t) return looksLikePath(t) ? shortenWorkspacePath(t, session) : t;
    } else if (typeof call.rawInput === "object") {
      const r = call.rawInput as Record<string, unknown>;
      if (typeof r.command === "string" || Array.isArray(r.args)) {
        const c = joinCommand(r.command, r.args);
        if (c) return c;
      }
      for (const key of ["path", "file_path", "file", "target"]) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) {
          return shortenWorkspacePath(v, session) || v;
        }
      }
      for (const key of ["query", "pattern", "text", "search"]) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }

  // 2. content (diff paths)
  for (const item of call.content ?? []) {
    if (item?.type === "diff" && typeof item.path === "string" && item.path) {
      const short = shortenWorkspacePath(item.path, session);
      if (short) return short;
    }
  }

  // 3. locations
  for (const loc of call.locations ?? []) {
    if (typeof loc?.path === "string" && loc.path) {
      const short = shortenWorkspacePath(loc.path, session);
      if (short) return short;
    }
  }

  // 4. title: strip common leading verbs and use the remainder if it looks useful
  const cleaned = fallback.replace(/^(Ran|Running|Executed|Search|Searched|Edit|Edited|Write|Wrote|Read|Delete|Deleted|Move|Moved)\s+(command\s+)?/i, "");
  if (cleaned && cleaned !== fallback) {
    const trimmed = cleaned.trim();
    if (looksLikePath(trimmed)) return shortenWorkspacePath(trimmed, session) || trimmed;
    return trimmed;
  }

  return fallback;
}

export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function relTime(input: string | number | null | undefined): string {
  if (!input) return "";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Loose subsequence match; returns a score (lower = better) or null. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = target.toLowerCase();
  if (t.includes(q)) return t.indexOf(q);
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found - ti;
    ti = found + 1;
  }
  return score + t.length / 100;
}

// ---- line diff --------------------------------------------------------------

export interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
}

/**
 * Line-based LCS diff between oldText and newText. Falls back to a plain
 * replace-all rendering for very large inputs to avoid the O(n·m) table.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 2_000_000) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const cols = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + j + 1] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i++] });
  while (j < b.length) out.push({ type: "add", text: b[j++] });
  return out;
}

/** Extract @path mentions from prompt text (skipping email-ish and code spans). */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(])@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[.,;:!?)\]]+$/, "");
    if (p && (p.includes("/") || p.includes(".") || p.startsWith("~"))) out.push(p);
  }
  return [...new Set(out)];
}

/** Resolve a mention path against the session cwd into a file:// URI. */
export function mentionToUri(mention: string, cwd: string): string {
  // `~` can't be resolved client-side — pass it through untouched and let the
  // agent expand it. Resolving it against cwd produced /cwd/~/x, a path that
  // never exists.
  if (mention.startsWith("~")) return `file://${mention}`;
  const abs = mention.startsWith("/") ? mention : `${cwd.replace(/[/\\]+$/, "")}/${mention}`;
  return `file://${abs}`;
}
