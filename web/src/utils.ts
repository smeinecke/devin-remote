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

export interface ReasoningExcerpt {
  /** Source fragment used for the preview ( Markdown is preserved). */
  preview: string;
  /** Plain-text preview ready for the collapsed trigger. */
  displayPreview: string;
  /** Markdown source that continues after the preview. */
  continuation: string;
  /** Whether the preview was truncated (the chevron should be shown). */
  truncated: boolean;
  /** Offset in the cleaned source where the split occurred. */
  splitAt?: number;
}

const REASONING_PREVIEW_MAX_LENGTH = 220;

/**
 * Split reasoning text into a plain-text preview and a Markdown continuation.
 *
 * The split is performed on the original source first, then only the preview
 * fragment is normalized for display. This keeps the continuation valid Markdown
 * and lets preview + continuation reconstruct the source without duplicating
 * text in the UI.
 */
export function splitReasoningExcerpt(
  source: string,
  maxPreviewLength = REASONING_PREVIEW_MAX_LENGTH,
  previousSplitAt?: number,
): ReasoningExcerpt {
  const cleaned = normalizeLineEndings(source);
  const length = cleaned.length;

  if (length <= maxPreviewLength) {
    return {
      preview: cleaned,
      displayPreview: normalizePreviewFragment(cleaned),
      continuation: "",
      truncated: false,
      splitAt: length,
    };
  }

  const splitAt = findReasoningSplitIndex(cleaned, maxPreviewLength, previousSplitAt);
  const previewSource = cleaned.slice(0, splitAt);
  const continuationSource = cleaned.slice(splitAt);

  return {
    preview: previewSource,
    displayPreview: normalizePreviewFragment(previewSource),
    continuation: continuationSource,
    truncated: splitAt < length,
    splitAt,
  };
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizePreviewFragment(text: string): string {
  return (
    text
      // Replace fenced code blocks with a compact marker in the preview only.
      .replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```[ \t]*\n?/gm, " [code] ")
      // Strip heading and blockquote markers.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      // Collapse all whitespace so line-clamp can wrap predictably.
      .replace(/\s+/g, " ")
      .trimEnd()
  );
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

function isParagraphBoundary(cleaned: string, i: number): boolean {
  return cleaned[i] === "\n" && cleaned[i - 1] === "\n";
}

function isSentenceBoundary(cleaned: string, i: number): boolean {
  if (!isWhitespace(cleaned[i] ?? "")) return false;
  const prev = cleaned[i - 1];
  if (!prev) return false;
  if (".!?".includes(prev)) return true;
  if (["\"", "'", ")"].includes(prev)) {
    const prev2 = cleaned[i - 2];
    if (prev2 && ".!?".includes(prev2)) return true;
  }
  return false;
}

function computeSafeSplitPositions(cleaned: string): boolean[] {
  const length = cleaned.length;
  const safe: boolean[] = new Array(length + 1).fill(true);

  // Never split inside a Unicode surrogate pair.
  for (let i = 1; i < length; i++) {
    const prev = cleaned[i - 1];
    const curr = cleaned[i];
    if (!prev || !curr) continue;
    const prevCode = prev.charCodeAt(0);
    const currCode = curr.charCodeAt(0);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff && currCode >= 0xdc00 && currCode <= 0xdfff) {
      safe[i] = false;
    }
    if (prev === "\\") {
      safe[i] = false;
    }
  }

  // Fenced code blocks are atomic.
  const fenceOpen = /^ {0,3}```[ \t]*[^\n]*(\n|$)/gm;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = fenceOpen.exec(cleaned)) !== null) {
    const start = openMatch.index;
    const searchFrom = start + openMatch[0].length;
    const fenceClose = /^ {0,3}```[ \t]*(\n|$)/gm;
    fenceClose.lastIndex = searchFrom;
    const closeMatch = fenceClose.exec(cleaned);
    const end = closeMatch ? closeMatch.index + closeMatch[0].length : length;
    for (let i = start + 1; i < end; i++) {
      safe[i] = false;
    }
    fenceOpen.lastIndex = end;
  }

  // Inline code spans are atomic.
  const inlineCode = /`([^`\n]*?)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineCode.exec(cleaned)) !== null) {
    const start = inlineMatch.index;
    const end = start + inlineMatch[0].length;
    for (let i = start + 1; i < end; i++) {
      safe[i] = false;
    }
  }

  // Markdown links are atomic.
  const link = /\[([^\]\n]*)\](?:\(([^)\n]*)\)|\[[^\]\n]*\])/g;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = link.exec(cleaned)) !== null) {
    const start = linkMatch.index;
    const end = start + linkMatch[0].length;
    for (let i = start + 1; i < end; i++) {
      safe[i] = false;
    }
  }

  return safe;
}

function findReasoningSplitIndex(
  cleaned: string,
  maxPreviewLength: number,
  previousSplitAt?: number,
): number {
  const safe = computeSafeSplitPositions(cleaned);
  const minBound = Math.max(1, Math.floor(maxPreviewLength * 0.6));

  const candidate = findSplitCandidate(cleaned, maxPreviewLength, safe, minBound);

  if (previousSplitAt !== undefined) {
    const prev = Math.min(previousSplitAt, cleaned.length);
    if (
      prev > 0 &&
      safe[prev] &&
      normalizePreviewFragment(cleaned.slice(0, prev)).length <= maxPreviewLength
    ) {
      // Keep the split from moving backward once the preview is full.
      return Math.max(candidate, prev);
    }
  }

  return candidate;
}

function findSplitCandidate(
  cleaned: string,
  maxPreviewLength: number,
  safe: boolean[],
  minBound: number,
): number {
  const target = maxPreviewLength;

  // If the target falls inside an atomic Markdown structure, prefer the
  // structure's start so we never slice it in half.
  if (!safe[target]) {
    const tokenStart = findNearestSafeBackward(cleaned, target, safe, 1);
    if (tokenStart !== null && tokenStart > 0) {
      return tokenStart;
    }
  }

  const paragraph = findBoundaryBackward(cleaned, target, minBound, safe, (i) =>
    isParagraphBoundary(cleaned, i),
  );
  if (paragraph !== null) return paragraph;

  const sentence = findBoundaryBackward(cleaned, target, minBound, safe, (i) =>
    isSentenceBoundary(cleaned, i),
  );
  if (sentence !== null) return sentence;

  const whitespace = findBoundaryBackward(cleaned, target, minBound, safe, (i) =>
    isWhitespace(cleaned[i] ?? ""),
  );
  if (whitespace !== null) return whitespace;

  const safeBoundary = findBoundaryBackward(cleaned, target, minBound, safe, (i) =>
    !isWordChar(cleaned[i - 1]) || !isWordChar(cleaned[i]),
  );
  if (safeBoundary !== null) return safeBoundary;

  // No good boundary before target; split at the target even if it is mid-word.
  if (safe[target]) return target;

  // Target is inside an atomic structure and its start is at 0; extend forward.
  const forward = findNearestSafeForward(cleaned, target, safe);
  return forward !== null ? forward : cleaned.length;
}

function findBoundaryBackward(
  cleaned: string,
  start: number,
  minBound: number,
  safe: boolean[],
  predicate: (i: number) => boolean,
): number | null {
  const end = Math.min(start, cleaned.length);
  for (let i = end; i >= minBound; i--) {
    if (safe[i] && predicate(i)) return i;
  }
  return null;
}

function findNearestSafeBackward(
  cleaned: string,
  start: number,
  safe: boolean[],
  minBound = 1,
): number | null {
  const end = Math.min(start - 1, cleaned.length - 1);
  for (let i = end; i >= minBound; i--) {
    if (safe[i]) return i;
  }
  if (safe[0] && minBound === 0) return 0;
  return null;
}

function findNearestSafeForward(
  cleaned: string,
  start: number,
  safe: boolean[],
): number | null {
  for (let i = start; i <= cleaned.length; i++) {
    if (safe[i]) return i;
  }
  return null;
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

export function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(0, i) || "/" : "/";
}

function splitPath(p: string): string[] {
  const trimmed = p.replace(/[/\\]+$/, "");
  return trimmed.split("/").filter((s, i, arr) => !(s === "" && i === 0 && arr.length > 1));
}

export function shortenPath(p: string, maxLength = 40, home?: string): string {
  if (!p) return "";

  // Collapse /home/<user> (or an explicitly supplied home directory) to ~.
  let compact = p.replace(/\\/g, "/");
  if (home && compact.startsWith(home.replace(/\\/g, "/").replace(/\/$/, ""))) {
    compact = "~" + compact.slice(home.length);
  } else if (/^\/home\/[^/]+/.test(compact)) {
    compact = compact.replace(/^\/home\/[^/]+/, "~");
  }

  if (compact.length <= maxLength) return compact;

  const parts = splitPath(compact);
  if (parts.length <= 3) return compact;

  const first = parts[0];
  const lastTwo = parts.slice(-2);
  const withTwo = [first, parts[1], "…", ...lastTwo].join("/");
  if (withTwo.length <= maxLength) return withTwo;

  const withOne = [first, "…", ...lastTwo].join("/");
  if (withOne.length <= maxLength) return withOne;

  const ellipsisLast = ["…", ...lastTwo].join("/");
  if (ellipsisLast.length <= maxLength) return ellipsisLast;

  const justLast = ["…", parts[parts.length - 1]].join("/");
  if (justLast.length <= maxLength) return justLast;

  return parts[parts.length - 1] || compact;
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
