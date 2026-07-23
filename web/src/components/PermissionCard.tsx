// Permission requests — blue left-border cards below the thread, with
// keyboard shortcuts (1/2/3…) mapped to the agent's options.

import { memo, useEffect, useRef, useState, type FC } from "react";
import { BotIcon, ShieldAlertIcon } from "lucide-react";
import type { PendingPermission, SessionState, SubagentDescriptor } from "../state";
import { resolvePermission, useStore } from "../state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function summarize(raw: unknown): string {
  if (raw == null) return "";
  try {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    return s.length > 1500 ? s.slice(0, 1500) + "\n…" : s;
  } catch {
    return String(raw);
  }
}

function isAllow(kind: string): boolean {
  return /allow|accept|approve|proceed|always|once/i.test(kind) && !/reject|deny/i.test(kind);
}

function subagentAncestry(session: SessionState | null | undefined, subagentId: string): string[] {
  const out: string[] = [];
  let current: SubagentDescriptor | undefined = session?.subagents[subagentId];
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    out.unshift(current.title ?? `Subagent ${current.id.slice(0, 8)}`);
    seen.add(current.id);
    current = current.parentSubagentId ? session?.subagents[current.parentSubagentId] : undefined;
  }
  return out;
}

const PermissionCard: FC<{ perm: PendingPermission; busy: boolean; onChoose: (id: string | null) => void }> = ({
  perm,
  busy,
  onChoose,
}) => {
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null));
  const detail = summarize(perm.toolCall?.rawInput);
  const subagent = perm.subagentId ? session?.subagents[perm.subagentId] : undefined;
  const ancestry = subagent ? subagentAncestry(session, perm.subagentId!) : null;
  const title = ancestry ? ancestry.join(" › ") : subagent?.title ?? null;
  const toolTitle = String(perm.toolCall?.title ?? perm.toolCall?.kind ?? "tool call");

  return (
    <div
      className="rounded-xl border border-border border-l-2 border-l-primary bg-card p-3 shadow-sm"
      aria-label={
        subagent ? `Subagent ${title} requests permission: ${toolTitle}` : `Permission requested: ${toolTitle}`
      }
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        {subagent ? <BotIcon className="size-4 text-primary" /> : <ShieldAlertIcon className="size-4 text-primary" />}
        {subagent ? (
          <>
            <span className="min-w-0 flex-1 truncate">{title ?? `Subagent ${perm.subagentId!.slice(0, 8)}`}</span>
            <span className="shrink-0 text-muted-foreground font-normal">requests permission</span>
          </>
        ) : (
          <>
            <span className="truncate">Permission requested</span>
            <span className="truncate text-muted-foreground font-normal">— {toolTitle}</span>
          </>
        )}
      </div>
      {detail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {detail}
        </pre>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {perm.options.map((o, i) => (
          <Button
            key={o.optionId}
            size="sm"
            variant={isAllow(o.kind) ? "default" : "ghost"}
            disabled={busy}
            className={cn("h-8 gap-1.5", !isAllow(o.kind) && "border border-border")}
            onClick={() => onChoose(o.optionId)}
          >
            {o.name}
            {i < 9 && <kbd className="tnum rounded bg-black/15 px-1 text-[10px] opacity-70">{i + 1}</kbd>}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          className="h-8 text-muted-foreground hover:text-destructive"
          onClick={() => onChoose(null)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
};

/** Renders every pending permission for the active session; owns 1/2/3 keys. */
export const PermissionStack: FC = memo(function PermissionStack() {
  const state = useStore();
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const permissions = session?.permissions ?? [];
  const [busy, setBusy] = useState(false);
  // Ref-backed gate: the keydown listener closes over one render's `busy`,
  // so key repeat could double-resolve a request through a stale false.
  const busyRef = useRef(false);

  const choose = async (requestId: string, optionId: string | null) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await resolvePermission(requestId, optionId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const first = permissions[0];
  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable))
        return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= first.options.length) {
        e.preventDefault();
        void choose(first.requestId, first.options[n - 1].optionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  if (permissions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {permissions.map((p) => (
        <PermissionCard key={p.requestId} perm={p} busy={busy} onChoose={(id) => void choose(p.requestId, id)} />
      ))}
    </div>
  );
});

export default PermissionStack;
