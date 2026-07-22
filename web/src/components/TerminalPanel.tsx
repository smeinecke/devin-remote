import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getTerminalOutput, setUi, useStore } from "../state";
import { sendTerminalInput, sendTerminalResize } from "../ws";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { SquareTerminalIcon, XIcon } from "lucide-react";

// Matched to the design tokens (warm surfaces, Devin blue accent cursor).
const XTERM_THEME = {
  background: "#131316",
  foreground: "#e4e4e7",
  cursor: "#3b82f6",
  selectionBackground: "#3b3b42",
  black: "#1c1c21",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#eab308",
  blue: "#60a5fa",
  magenta: "#bb9af7",
  cyan: "#22d3ee",
  white: "#e8e8ee",
  brightBlack: "#55555f",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#facc15",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

function XTermView({
  id,
  version,
  resetSeq,
  sessionId,
  exited,
}: {
  id: string;
  version: number;
  resetSeq: number;
  sessionId: string;
  exited: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);
  const resetRef = useRef(resetSeq);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsConnected = useStore((s) => s.wsConnected);

  const sendResize = (term: Terminal) => {
    if (!exited) sendTerminalResize(id, term.cols, term.rows, sessionId);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      theme: XTERM_THEME,
      scrollback: 10000,
      disableStdin: false,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    writtenRef.current = 0;

    const existing = getTerminalOutput(id);
    if (existing) {
      term.write(existing);
      writtenRef.current = existing.length;
    }

    const inputDispose = term.onData((data) => {
      if (!exited) sendTerminalInput(id, data, sessionId);
    });

    const resizeDispose = term.onResize(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => sendResize(term), 100);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* disposed */
      }
    });
    ro.observe(host);

    host.addEventListener("click", () => term.focus());

    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      ro.disconnect();
      inputDispose.dispose();
      resizeDispose.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [id]);

  // When the WebSocket reconnects, re-send the current PTY size.
  useEffect(() => {
    const term = termRef.current;
    if (term && wsConnected) sendResize(term);
  }, [wsConnected, id, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (resetRef.current !== resetSeq) {
      resetRef.current = resetSeq;
      term.reset();
      writtenRef.current = 0;
    }
    const data = getTerminalOutput(id);
    if (data.length > writtenRef.current) {
      term.write(data.slice(writtenRef.current));
      writtenRef.current = data.length;
      term.scrollToBottom();
    }
  }, [id, version, resetSeq]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = exited;
    if (exited) {
      term.blur();
    } else {
      term.focus();
    }
  }, [exited]);

  return (
    <div className="relative min-h-0 flex-1 px-2 py-1.5 [&_.xterm]:h-full" ref={hostRef}>
      {exited && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center bg-card/80 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
          Process exited — input disabled
        </div>
      )}
    </div>
  );
}

export default function TerminalPanel() {
  const state = useStore();
  const activeId = state.activeSessionId;
  const all = Object.values(state.terminals);
  const forSession = activeId ? all.filter((t) => t.sessionId === activeId) : all;
  const shown = forSession.length > 0 ? forSession : all;

  const selected =
    (state.ui.activeTerminalId && state.terminals[state.ui.activeTerminalId]) ||
    shown[shown.length - 1] ||
    null;

  return (
    <div className="flex h-64 flex-none flex-col border-t border-border bg-card/40">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-border px-3">
        <SquareTerminalIcon className="size-3.5 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {shown.map((t) => (
            <button
              key={t.id}
              className={cn(
                "tnum flex flex-none items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] transition-colors duration-100",
                selected?.id === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => setUi({ activeTerminalId: t.id })}
            >
              {t.id.slice(0, 8)}
              {t.exitCode !== null && (
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px] font-medium",
                    t.exitCode === 0
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400",
                  )}
                >
                  exit {t.exitCode}
                </span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <span className="font-sans text-xs text-muted-foreground">
              No terminals yet — they appear when Devin runs commands.
            </span>
          )}
        </div>
        <TooltipIconButton
          tooltip="Close terminals"
          variant="ghost"
          size="icon"
          className="size-7 flex-none"
          aria-label="close terminals"
          onClick={() => setUi({ terminalOpen: false })}
        >
          <XIcon className="size-3.5" />
        </TooltipIconButton>
      </div>
      {selected ? (
        <XTermView
          id={selected.id}
          version={selected.version}
          resetSeq={selected.resetSeq}
          sessionId={selected.sessionId}
          exited={selected.exitCode !== null || selected.signal !== null}
        />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
