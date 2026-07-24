import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { setUi, useStore } from "../state";
import type { AgentActivity, SubagentDescriptor } from "../store-types";
import {
  ActivityIcon,
  BotIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FilesIcon,
  LayoutListIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";

const TerminalPanel = lazy(() => import("./TerminalPanel"));
const AgentLogDrawer = lazy(() => import("./AgentLogDrawer"));
const PlanPanel = lazy(() => import("./PlanPanel").then((m) => ({ default: m.PlanPanel })));

type TabKey = "activity" | "changes" | "terminal" | "files" | "logs" | "plan";

const TABS: { key: TabKey; label: string; icon: typeof ActivityIcon }[] = [
  { key: "activity", label: "Activity", icon: ActivityIcon },
  { key: "changes", label: "Changes", icon: FileCodeIcon },
  { key: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { key: "files", label: "Files", icon: FilesIcon },
  { key: "logs", label: "Logs", icon: ScrollTextIcon },
  { key: "plan", label: "Plan", icon: LayoutListIcon },
];

function statusDot(status: AgentActivity["status"]) {
  return cn(
    "size-2 rounded-full",
    status === "completed" && "bg-emerald-500",
    status === "failed" && "bg-red-500",
    status === "cancelled" && "bg-amber-500",
    status === "in_progress" && "bg-primary animate-pulse",
    status === "pending" && "bg-muted-foreground/50",
  );
}

function formatDuration(ms: number): string | null {
  if (ms < 400) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function subagentStatusLabel(status: SubagentDescriptor["status"]): string {
  switch (status) {
    case "waiting_for_permission":
      return "Waiting for approval";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "starting":
      return "Starting";
    default:
      return "Pending";
  }
}

function activityStatusLabel(activity: AgentActivity): string {
  const subagent = (activity.details as { subagent?: SubagentDescriptor } | undefined)?.subagent;
  if (subagent) return subagentStatusLabel(subagent.status);
  if (activity.status === "in_progress") return "Running";
  return activity.status.replace(/_/g, " ");
}

const COUNTABLE_TYPES: Record<string, string> = {
  file_read: "file",
  file_edit: "file edit",
  command: "command",
  test: "test",
  search: "search",
  permission: "permission",
  subagent: "subagent",
  terminal: "terminal",
};

function pluralize(n: number, label: string): string {
  return `${n} ${label}${n === 1 ? "" : label === "search" ? "es" : "s"}`;
}

function subagentSummary(activity: AgentActivity): string | null {
  const subagent = (activity.details as { subagent?: SubagentDescriptor } | undefined)?.subagent;
  if (!subagent) return null;

  if (subagent.status === "failed" && subagent.error) {
    return subagent.error;
  }
  if (subagent.status === "cancelled") {
    return "Cancelled";
  }

  const counts: Record<string, number> = {};
  for (const child of activity.children ?? []) {
    const label = COUNTABLE_TYPES[child.type] ?? "tool";
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const [label, count] of Object.entries(counts)) {
    parts.push(pluralize(count, label));
  }

  if (subagent.completedAt && subagent.startedAt) {
    const duration = formatDuration(subagent.completedAt - subagent.startedAt);
    if (duration) parts.push(duration);
  }

  if (parts.length > 0) return parts.join(" · ");
  if (subagent.result) return subagent.result.length > 120 ? `${subagent.result.slice(0, 120)}…` : subagent.result;
  return null;
}

function ActivityItem({ activity, depth = 0 }: { activity: AgentActivity; depth?: number }) {
  const [expanded, setExpanded] = useState(activity.autoExpand ?? false);
  const manuallyChanged = useRef(false);
  const isSubagent = activity.type === "subagent";
  const hasChildren = (activity.children?.length ?? 0) > 0;
  const subagent = (activity.details as { subagent?: SubagentDescriptor } | undefined)?.subagent;
  const summary = subagentSummary(activity);
  const canExpand = hasChildren || !!subagent?.prompt || !!subagent?.result || !!subagent?.error || activity.meta?.command || activity.meta?.path;

  useEffect(() => {
    if (!manuallyChanged.current && activity.autoExpand) {
      setExpanded(true);
    }
  }, [activity.autoExpand]);

  const toggleExpanded = () => {
    manuallyChanged.current = true;
    setExpanded((e) => !e);
  };

  return (
    <div
      key={activity.id}
      className={cn(
        "rounded-md border border-border bg-muted/40 p-2.5 text-xs",
        activity.status === "in_progress" && "border-primary/30 bg-primary/5",
        activity.status === "failed" && "border-red-500/30",
        depth > 0 && "ml-2 sm:ml-4",
      )}
    >
      <button
        type="button"
        disabled={!canExpand}
        aria-label={isSubagent ? `Subagent: ${activity.title}` : activity.title}
        onClick={toggleExpanded}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-left",
          canExpand && "cursor-pointer",
        )}
      >
        {isSubagent ? (
          <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className={statusDot(activity.status)} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{activity.title}</span>
        <span
          className={cn(
            "shrink-0 text-[11px] font-medium",
            subagent?.status === "failed" && "text-red-500",
            subagent?.status === "completed" && "text-emerald-500",
            subagent?.status === "waiting_for_permission" && "text-primary",
            !subagent && "text-muted-foreground",
          )}
        >
          {activityStatusLabel(activity)}
        </span>
        {canExpand && (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>
      {summary && (
        <div className={cn("mt-1 truncate text-muted-foreground", subagent?.status === "failed" && "text-red-500/80")}>
          {summary}
        </div>
      )}
      {expanded && subagent?.prompt && (
        <div className="mt-2 rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
          {subagent.prompt}
        </div>
      )}
      {expanded && activity.meta?.path && (
        <div className="mt-1 truncate text-muted-foreground">{activity.meta.path}</div>
      )}
      {expanded && activity.meta?.command && (
        <div className="mt-1 truncate font-mono text-muted-foreground">{activity.meta.command}</div>
      )}
      {expanded && subagent?.result && subagent.status !== "failed" && (
        <div className="mt-2 line-clamp-6 text-muted-foreground">{subagent.result}</div>
      )}
      {expanded && hasChildren && (
        <div className="mt-2 flex flex-col gap-2">
          {activity.children!.map((child: AgentActivity) => (
            <ActivityItem key={child.id} activity={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export { ActivityItem };

function ActivityTab() {
  const { activeSessionId, sessions } = useStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const runs = useMemo(() => Object.values(session?.runs ?? {}), [session?.runs]);
  const activeRun = runs[runs.length - 1];

  if (!activeRun) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active run yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3">
      <div className="text-xs font-medium text-muted-foreground">
        {activeRun.activities.length} activit{activeRun.activities.length === 1 ? "y" : "ies"}
        {activeRun.status !== "running" && ` · ${activeRun.status}`}
      </div>
      {activeRun.activities.map((a) => (
        <ActivityItem key={a.id} activity={a} />
      ))}
      {activeRun.plan && activeRun.plan.length > 0 && (
        <div className="mt-2 rounded-md border border-border p-2.5">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Plan</div>
          {activeRun.plan.map((p, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 text-muted-foreground">
                {p.status === "completed" ? "✓" : p.status === "in_progress" ? "●" : "○"}
              </span>
              <span>{p.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChangesTab() {
  const { activeSessionId, sessions } = useStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const diffs = useMemo(() => {
    const out: { id: string; path: string; oldText: string | null; newText: string }[] = [];
    if (!session) return out;
    for (const t of Object.values(session.toolCalls)) {
      for (const c of t.content ?? []) {
        const item = c as { type: string; path?: string; oldText?: string | null; newText?: string };
        if (item.type === "diff" && item.path) {
          out.push({ id: `${t.id}-${item.path}`, path: item.path, oldText: item.oldText ?? null, newText: item.newText ?? "" });
        }
      }
    }
    return out;
  }, [session]);

  if (diffs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No edits yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3">
      {diffs.map((d) => (
        <div key={d.id} className="rounded-md border border-border bg-muted/40 p-2.5 text-xs">
          <div className="font-mono text-muted-foreground">{d.path}</div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
            {d.newText}
          </pre>
        </div>
      ))}
    </div>
  );
}

function FilesTab() {
  const { activeSessionId, sessions } = useStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const files = useMemo(() => {
    const paths = new Set<string>();
    if (!session) return [];
    for (const t of Object.values(session.toolCalls)) {
      for (const c of t.content ?? []) {
        const item = c as { type: string; path?: string };
        if (item.path) paths.add(item.path);
      }
      for (const l of t.locations ?? []) {
        if (l.path) paths.add(l.path);
      }
    }
    return [...paths];
  }, [session]);

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No files referenced yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      {files.map((f) => (
        <div key={f} className="truncate border-b border-border py-1.5 font-mono text-xs text-muted-foreground last:border-0">
          {f}
        </div>
      ))}
    </div>
  );
}

export default function Inspector() {
  const { ui, activeSessionId } = useStore();
  const tab = ui.inspectorTab;
  const hasSession = !!activeSessionId;

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <div className="flex h-10 flex-none items-center gap-1 border-b border-border px-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            title={label}
            onClick={() => setUi({ inspectorTab: key, inspectorOpen: true })}
            className={cn(
              "flex flex-1 items-center justify-center rounded-md py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              tab === key && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
        <TooltipIconButton
          className="size-7 flex-none"
          aria-label="close inspector"
          onClick={() => setUi({ inspectorOpen: false })}
        >
          <XIcon className="size-3.5" />
        </TooltipIconButton>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-3 text-sm text-muted-foreground">Loading…</div>}>
          {tab === "activity" && <ActivityTab />}
          {tab === "changes" && <ChangesTab />}
          {tab === "terminal" && hasSession && <TerminalPanel />}
          {tab === "terminal" && !hasSession && <NoSession />}
          {tab === "files" && <FilesTab />}
          {tab === "logs" && <AgentLogDrawer />}
          {tab === "plan" && <PlanPanel />}
        </Suspense>
      </div>
    </div>
  );
}

function NoSession() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Select a session to view details.
    </div>
  );
}

// Minimal local icon button to avoid circular imports.
function TooltipIconButton({
  children,
  onClick,
  className,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
