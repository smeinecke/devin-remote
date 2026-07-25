import { useMemo, useState } from "react";
import { api } from "../api";
import {
  createSession,
  dropSession,
  refreshSessions,
  renameSession,
  selectSession,
  setUi,
  showNotice,
  useStore,
} from "../state";
import type { SessionState } from "../state";
import { fuzzyScore, relTime, truncate, workspaceMeetsModeRequirements } from "../utils";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { DevinLogo } from "./DevinLogo";
import WorkspacePathField from "./WorkspacePathField";
import type { DirectoryValidationResponse } from "../types";
import {
  ChartColumnIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

export function sessionLabel(s: SessionState): string {
  return s.alias || s.title || `session ${s.sessionId.slice(0, 8)}`;
}

export default function Sidebar() {
  const state = useStore();
  const [cwdInput, setCwdInput] = useState("");
  const [validation, setValidation] = useState<DirectoryValidationResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const workspaces = useMemo(() => {
    return (state.meta?.workspaces ?? []).slice(0, 15);
  }, [state.meta]);

  const sessions = useMemo(() => {
    const all = Object.values(state.sessions);
    const filtered = filter.trim()
      ? all
          .map((s) => {
            const score = Math.min(
              ...[sessionLabel(s), s.cwd, s.sessionId].map((t) => fuzzyScore(filter, t) ?? Infinity),
            );
            return { s, score };
          })
          .filter(({ score }) => score !== Infinity)
          .sort((a, b) => a.score - b.score)
          .map(({ s }) => s)
      : all;
    return filtered.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [state.sessions, filter]);

  const validationForInput =
    validation && validation.input === cwdInput.trim() ? validation : null;

  const workspaceCheck = workspaceMeetsModeRequirements(
    validationForInput,
    state.settings.defaultMode,
    state.settings.worktreeIsolation,
  );

  const canCreate = !creating && workspaceCheck.allowed;

  const submitNew = async () => {
    const dir = cwdInput.trim() || state.meta?.primaryCwd || "";
    if (!dir || creating || !canCreate) return;
    setCreating(true);
    await createSession(dir);
    setCreating(false);
    setCwdInput("");
    setValidation(null);
  };

  const commitRename = async (id: string) => {
    const title = renameText.trim();
    setRenamingId(null);
    if (title) await renameSession(id, title);
  };

  const loadingList = state.sessionsLoading && sessions.length === 0;

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-70 flex-col border-r border-border bg-background transition-transform duration-200 ease-out",
        "md:static md:translate-x-0",
        state.ui.sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
      )}
    >
      {/* workspace header */}
      <div className="flex h-14 flex-none items-center gap-2 px-4">
        <DevinLogo size={22} className="text-foreground" wordmarkClassName="text-[15px]" />
        <span className="flex-1" />
        <span
          className={cn(
            "size-1.5 rounded-full",
            state.wsConnected ? "bg-emerald-500" : "animate-pulse bg-red-500",
          )}
          title={state.wsConnected ? "connected" : "reconnecting…"}
        />
      </div>

      {/* new session */}
      <div className="flex flex-none flex-col gap-2 px-3 pb-2">
        <WorkspacePathField
          value={cwdInput}
          onChange={setCwdInput}
          recentPaths={workspaces}
          primaryCwd={state.meta?.primaryCwd}
          mode={state.settings.defaultMode}
          worktreeIsolation={state.settings.worktreeIsolation}
          disabled={creating}
          onValidationChange={setValidation}
        />
        <button
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50"
          onClick={() => void submitNew()}
          disabled={!canCreate}
        >
          {creating ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
          New session
        </button>
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 border-transparent bg-transparent pl-8 text-xs shadow-none focus-visible:bg-secondary"
            placeholder="Search sessions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {/* recent sessions */}
      <div className="flex items-center gap-2 px-4 pb-1 pt-2">
        <span className="text-[13px] font-medium text-muted-foreground">Recent</span>
        <span className="flex-1" />
        <TooltipIconButton
          tooltip="Refresh sessions"
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={() => void refreshSessions()}
          disabled={state.sessionsLoading}
        >
          {state.sessionsLoading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </TooltipIconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loadingList && (
          <div className="flex flex-col gap-2 p-1.5" aria-label="Loading sessions">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="dc-shimmer h-12 rounded-lg" />
            ))}
          </div>
        )}
        {!loadingList && sessions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {state.sessionsLoaded ? "No sessions yet — create one above." : "No sessions yet"}
          </div>
        )}
        {sessions.map((s, i) => (
          <div
            key={s.sessionId}
            role="button"
            tabIndex={0}
            style={{ animationDelay: `${Math.min(i * 20, 160)}ms` }}
            className={cn(
              "group relative flex cursor-pointer items-center gap-1 rounded-lg border border-transparent px-2.5 py-2 transition-all duration-150",
              "hover:bg-secondary/70 active:scale-[0.99]",
              s.sessionId === state.activeSessionId && "border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
            )}
            onClick={() => renamingId !== s.sessionId && selectSession(s.sessionId)}
            onKeyDown={(e) => {
              if (e.key === "Enter") selectSession(s.sessionId);
            }}
          >
            {s.running && (
              <span className="absolute left-0.5 top-1/2 size-1.5 -translate-y-1/2 animate-pulse rounded-full bg-primary" />
            )}
            {renamingId === s.sessionId ? (
              <div className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Input
                  className="h-7 flex-1 bg-background px-1.5 text-xs"
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(s.sessionId);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
                <TooltipIconButton
                  tooltip="Save"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => void commitRename(s.sessionId)}
                >
                  <CheckIcon className="size-3.5" />
                </TooltipIconButton>
                <TooltipIconButton
                  tooltip="Cancel"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => setRenamingId(null)}
                >
                  <XIcon className="size-3.5" />
                </TooltipIconButton>
              </div>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={sessionLabel(s)}>
                    {truncate(sessionLabel(s), 90)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    {s.updatedAt && <span>{relTime(s.updatedAt)}</span>}
                    <span className="tnum font-mono opacity-60">· {s.sessionId.slice(0, 8)}</span>
                  </div>
                </div>
                <div className="flex flex-none items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <TooltipIconButton
                    tooltip="Rename"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(s.sessionId);
                      setRenameText(sessionLabel(s));
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    tooltip="Export zip"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.open(api.exportUrl(s.sessionId), "_blank", "noopener,noreferrer");
                    }}
                  >
                    <DownloadIcon className="size-3.5" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    tooltip="Copy session id"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard
                        .writeText(s.sessionId)
                        .then(() => showNotice("session id copied"))
                        .catch(() => showNotice("copy failed"));
                    }}
                  >
                    <CopyIcon className="size-3.5" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    tooltip="Drop session"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-red-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Drop session "${sessionLabel(s)}"?`)) {
                        void dropSession(s.sessionId);
                      }
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </TooltipIconButton>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* settings pinned at bottom */}
      <div className="flex h-12 flex-none items-center gap-1 border-t border-border px-3">
        <button
          className="flex h-9 flex-1 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
          onClick={() => setUi({ modal: "settings" })}
        >
          <SettingsIcon className="size-4" />
          Settings
        </button>
        <TooltipIconButton
          tooltip="Usage"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={() => setUi({ modal: "usage" })}
        >
          <ChartColumnIcon className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="Search (Ctrl+K)"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={() => setUi({ modal: "palette" })}
        >
          <SearchIcon className="size-4" />
        </TooltipIconButton>
      </div>
    </aside>
  );
}
