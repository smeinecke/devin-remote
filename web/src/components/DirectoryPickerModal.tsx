import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { DirectoryEntry, DirectoryListingResponse } from "../types";
import { shortenPath } from "../utils";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  HomeIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";

export interface DirectoryPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
  onSelect: (path: string) => void;
}

interface PickerState {
  currentPath: string;
  loading: boolean;
  showHidden: boolean;
  listing: DirectoryListingResponse | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function emptyListing(path: string): DirectoryListingResponse {
  return { path, parent: null, entries: [], allowed: true, writable: false };
}

export default function DirectoryPickerModal({
  open,
  onOpenChange,
  initialPath,
  onSelect,
}: DirectoryPickerModalProps) {
  const [state, setState] = useState<PickerState>({
    currentPath: initialPath,
    loading: false,
    showHidden: false,
    listing: null,
    errorCode: null,
    errorMessage: null,
  });
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = async (path: string) => {
    setState((s) => ({ ...s, currentPath: path, loading: true, errorCode: null, errorMessage: null }));
    try {
      const listing = await api.listDirectories(path, state.showHidden);
      setState((s) => ({
        ...s,
        listing,
        loading: false,
        errorCode: listing.errorCode ?? null,
        errorMessage: listing.errorCode ? directoryErrorMessage(listing.errorCode, path) : null,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        errorCode: "IO_ERROR",
        errorMessage: err instanceof Error ? err.message : "Failed to load directory",
      }));
    }
  };

  useEffect(() => {
    if (!open) return;
    setNewName("");
    load(initialPath || "/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  useEffect(() => {
    if (!state.listing) return;
    load(state.currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showHidden]);

  const filteredEntries = useMemo(() => {
    if (!state.listing) return [];
    let entries = state.listing.entries;
    if (!state.showHidden) entries = entries.filter((e) => !e.hidden);
    return entries;
  }, [state.listing, state.showHidden]);

  const navigateTo = (path: string) => {
    void load(path);
  };

  const navigateUp = () => {
    const parent = state.listing?.parent;
    if (parent) void load(parent);
  };

  const breadcrumbs = useMemo(() => {
    const parts = state.currentPath.replace(/\\/g, "/").split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let built = "";
    for (const part of parts) {
      built += `/${part}`;
      out.push({ label: part || "/", path: built });
    }
    return out;
  }, [state.currentPath]);

  const handleRefresh = () => load(state.currentPath);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return;
    const target = `${state.currentPath.replace(/[/\\]+$/, "")}/${name}`;
    setCreating(true);
    try {
      const result = await api.createDirectory(target);
      if (result.exists && result.isDirectory) {
        setNewName("");
        void load(state.currentPath);
      } else {
        setState((s) => ({
          ...s,
          errorCode: result.errorCode ?? "IO_ERROR",
          errorMessage: directoryErrorMessage(result.errorCode ?? "IO_ERROR", target),
        }));
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        errorCode: "IO_ERROR",
        errorMessage: err instanceof Error ? err.message : "Failed to create directory",
      }));
    } finally {
      setCreating(false);
    }
  };

  const handleSelect = () => {
    onSelect(state.currentPath);
    onOpenChange(false);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void load(e.currentTarget.value);
    }
  };

  const handleEntryKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, entry: DirectoryEntry) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigateTo(entry.path);
    }
  };

  const writable = state.listing?.entries.some((e) => e.writable) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg",
          "max-sm:fixed max-sm:inset-0 max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-2 max-sm:border-border",
        )}
        aria-describedby="dp-desc"
      >
        <DialogHeader className="px-4 pt-3 pb-2">
          <DialogTitle className="text-sm font-semibold">Select workspace</DialogTitle>
          <DialogDescription id="dp-desc" className="sr-only">
            Browse directories on the Devin Remote host and choose a workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4 py-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="dp-path" className="text-xs font-medium text-muted-foreground">
              Path
            </label>
            <Input
              id="dp-path"
              ref={inputRef}
              value={state.currentPath}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="tnum font-mono text-xs"
              onChange={(e) => setState((s) => ({ ...s, currentPath: e.target.value }))}
              onKeyDown={handlePathKeyDown}
              onBlur={() => load(state.currentPath)}
            />
          </div>

          <nav
            aria-label="Breadcrumbs"
            className="flex items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground"
          >
            <button
              type="button"
              className="flex flex-none items-center gap-0.5 rounded p-0.5 hover:text-foreground"
              onClick={() => navigateTo(state.listing?.parent ?? state.currentPath)}
              disabled={!state.listing?.parent}
              aria-label="Parent directory"
            >
              <HomeIcon className="size-3.5" />
            </button>
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex flex-none items-center">
                <ChevronRightIcon className="size-3 opacity-50" />
                <button
                  type="button"
                  onClick={() => navigateTo(crumb.path)}
                  className="max-w-[6rem] truncate rounded p-0.5 hover:text-foreground sm:max-w-[10rem]"
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="Folders"
          className="min-h-0 flex-1 overflow-y-auto border-y border-border px-2 py-1"
        >
          {state.loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" aria-live="polite">
              <Loader2Icon className="size-4 animate-spin" />
              Loading directories…
            </div>
          )}

          {!state.loading && state.errorMessage && (
            <div className="py-6 text-center text-xs text-red-500" role="alert" aria-live="assertive">
              {state.errorMessage}
            </div>
          )}

          {!state.loading && !state.errorMessage && filteredEntries.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No directories {state.showHidden ? "" : "(hidden folders are hidden)"}
            </div>
          )}

          {!state.loading &&
            filteredEntries.map((entry) => (
              <div
                key={entry.path}
                role="option"
                tabIndex={0}
                aria-selected={false}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => navigateTo(entry.path)}
                onDoubleClick={() => navigateTo(entry.path)}
                onKeyDown={(e) => handleEntryKeyDown(e, entry)}
              >
                <FolderIcon className="size-4 flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={entry.path}>
                  {entry.name}
                </span>
              </div>
            ))}
        </div>

        <div className="flex flex-col gap-2 px-4 pb-4 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setState((s) => ({ ...s, showHidden: !s.showHidden }))}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-secondary"
                aria-pressed={state.showHidden}
              >
                {state.showHidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                Hidden
              </button>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={state.loading}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
              >
                <RefreshCwIcon className={cn("size-3.5", state.loading && "animate-spin")} />
                Refresh
              </button>
            </div>

            <div className="flex items-center gap-2">
              {writable && (
                <div className="flex items-center gap-1">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreate();
                    }}
                    placeholder="New folder"
                    className="h-8 w-28 px-2 text-xs sm:w-36"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={creating || !newName.trim()}
                    className="flex h-8 flex-none items-center gap-1 rounded-md bg-secondary px-2 text-xs font-medium text-secondary-foreground hover:bg-accent disabled:opacity-50"
                  >
                    {creating ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                    Create
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={state.currentPath}>
                  {state.listing?.allowed ? shortenPath(state.currentPath) : state.errorMessage}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="break-all font-mono text-xs">{state.currentPath}</p>
              </TooltipContent>
            </Tooltip>

            <div className="flex flex-none items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSelect}
                disabled={!state.listing?.allowed}
                className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Select folder
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function directoryErrorMessage(code: string, path: string): string {
  switch (code) {
    case "INVALID_PATH":
      return "Invalid path";
    case "PATH_NOT_FOUND":
      return "Directory not found";
    case "NOT_A_DIRECTORY":
      return "Not a directory";
    case "OUTSIDE_ALLOWED_ROOT":
      return "Outside allowed workspace roots";
    case "PERMISSION_DENIED":
      return "Permission denied";
    case "SYMLINK_ESCAPE":
      return "Symlink escapes allowed roots";
    case "IO_ERROR":
      return `Could not read ${path}`;
    default:
      return code;
  }
}
