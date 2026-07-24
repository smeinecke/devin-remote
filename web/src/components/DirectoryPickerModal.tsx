import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { DirectoryEntry, DirectoryListingResponse, FilesystemRoot } from "../types";
import { shortenPath, validationErrorMessage } from "../utils";
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
  ArrowUpIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  HardDriveIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";

export interface DirectoryPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
  mode?: string | null;
  worktreeIsolation?: boolean;
  onSelect: (path: string) => void;
}

interface PickerError {
  code: string;
  message: string;
}

interface PickerState {
  inputPath: string;
  requestedPath: string;
  listing: DirectoryListingResponse | null;
  listingForPath: string | null;
  roots: FilesystemRoot[];
  rootsLoading: boolean;
  rootsError: PickerError | null;
  loading: boolean;
  creating: boolean;
  showHidden: boolean;
  error: PickerError | null;
}

export default function DirectoryPickerModal({
  open,
  onOpenChange,
  initialPath,
  mode = null,
  worktreeIsolation = false,
  onSelect,
}: DirectoryPickerModalProps) {
  const [state, setState] = useState<PickerState>({
    inputPath: initialPath,
    requestedPath: initialPath,
    listing: null,
    listingForPath: null,
    roots: [],
    rootsLoading: false,
    rootsError: null,
    loading: false,
    creating: false,
    showHidden: false,
    error: null,
  });
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const openSeq = useRef(0);

  const setPartial = useCallback((partial: Partial<PickerState>) => {
    setState((s) => ({ ...s, ...partial }));
  }, []);

  const loadDirectory = useCallback(
    async (path: string) => {
      const seq = ++loadSeq.current;

      setState((s) => ({
        ...s,
        inputPath: path,
        requestedPath: path,
        loading: true,
        error: null,
        // Clear stale listings so Select cannot use an old directory.
        listing: null,
        listingForPath: null,
      }));

      try {
        const listing = await api.listDirectories(path, state.showHidden);
        if (seq !== loadSeq.current) return;

        const error: PickerError | null = listing.errorCode
          ? { code: listing.errorCode, message: validationErrorMessage(listing.errorCode) }
          : null;

        setState((s) => ({
          ...s,
          inputPath: listing.path,
          requestedPath: listing.path,
          listing,
          listingForPath: listing.path,
          loading: false,
          error,
        }));
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setState((s) => ({
          ...s,
          listing: null,
          listingForPath: null,
          loading: false,
          error: {
            code: "IO_ERROR",
            message: err instanceof Error ? err.message : "Failed to load directory",
          },
        }));
      }
    },
    [state.showHidden],
  );

  const initialize = useCallback(
    async (preferred: string) => {
      const seq = ++openSeq.current;
      loadSeq.current++;

      setState((s) => ({
        ...s,
        rootsLoading: true,
        rootsError: null,
        loading: true,
        error: null,
        listing: null,
        listingForPath: null,
      }));

      let roots: FilesystemRoot[] = [];
      try {
        const res = await api.filesystemRoots();
        roots = res.roots;
      } catch (err) {
        if (seq !== openSeq.current) return;
        setState((s) => ({
          ...s,
          rootsLoading: false,
          rootsError: {
            code: "IO_ERROR",
            message: err instanceof Error ? err.message : "Failed to load workspace roots",
          },
          loading: false,
        }));
        return;
      }

      if (seq !== openSeq.current) return;

      if (roots.length === 0) {
        setState((s) => ({
          ...s,
          roots,
          rootsLoading: false,
          loading: false,
          error: {
            code: "NO_WORKSPACE_ROOTS",
            message: "No workspace roots are configured.",
          },
        }));
        return;
      }

      setState((s) => ({ ...s, roots, rootsLoading: false }));

      if (preferred.trim()) {
        try {
          const validation = await api.validateDirectory(preferred);
          if (seq !== openSeq.current) return;
          if (validation.allowed && validation.resolvedPath) {
            await loadDirectory(validation.resolvedPath);
            return;
          }
        } catch {
          // fall through to first root
        }
      }

      if (seq !== openSeq.current) return;
      await loadDirectory(roots[0].path);
    },
    [loadDirectory],
  );

  useEffect(() => {
    if (!open) {
      // Closing invalidates any in-flight load/open sequences.
      loadSeq.current++;
      openSeq.current++;
      return;
    }
    setNewName("");
    setNewNameError(null);
    void initialize(initialPath);
  }, [open, initialPath, initialize]);

  useEffect(() => {
    if (!open) return;
    // showHidden changed: reload the current canonical directory.
    const current = state.listingForPath ?? state.requestedPath;
    if (current) {
      void loadDirectory(current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showHidden]);

  const navigateTo = useCallback(
    (path: string) => {
      void loadDirectory(path);
    },
    [loadDirectory],
  );

  const navigateUp = useCallback(() => {
    const parent = state.listing?.parent;
    if (parent) void loadDirectory(parent);
  }, [state.listing, loadDirectory]);

  const handleRefresh = useCallback(() => {
    const current = state.listingForPath ?? state.inputPath;
    if (current) void loadDirectory(current);
  }, [state.listingForPath, state.inputPath, loadDirectory]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setNewNameError("Invalid folder name");
      return;
    }

    const currentDir = state.listing?.path;
    if (!currentDir) {
      setNewNameError("No current directory");
      return;
    }

    const target = `${currentDir.replace(/[/\\]+$/, "")}/${name}`;
    setPartial({ creating: true });
    setNewNameError(null);
    try {
      const result = await api.createDirectory(target);
      if (result.exists && result.isDirectory && result.allowed) {
        setNewName("");
        await loadDirectory(currentDir);
      } else {
        setNewNameError(validationErrorMessage(result.errorCode ?? "IO_ERROR"));
      }
    } catch (err) {
      setNewNameError(err instanceof Error ? err.message : "Failed to create directory");
    } finally {
      setPartial({ creating: false });
    }
  }, [newName, state.listing, loadDirectory]);

  const canSelect = useMemo(() => {
    if (state.loading || state.creating) return false;
    if (state.error || !state.listing) return false;
    if (!state.listing.allowed || !state.listing.path) return false;
    if (state.listing.errorCode) return false;
    if (state.inputPath !== state.requestedPath) return false;
    if (state.listing.path !== state.requestedPath) return false;
    if (state.listingForPath !== state.requestedPath) return false;
    // A successful listing means the directory exists and is readable.
    const needsWritable = worktreeIsolation || mode !== "ask";
    if (needsWritable && !state.listing.writable) return false;
    return true;
  }, [state, mode, worktreeIsolation]);

  const canCreateFolder = useMemo(() => {
    if (state.loading || state.creating) return false;
    if (state.error || !state.listing) return false;
    if (state.listing.errorCode) return false;
    if (state.listing.path !== state.requestedPath) return false;
    return state.listing.writable === true;
  }, [state]);

  const handleSelect = useCallback(() => {
    if (!canSelect || !state.listing) return;
    onSelect(state.listing.path);
    onOpenChange(false);
  }, [canSelect, state.listing, onSelect, onOpenChange]);

  const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const path = e.currentTarget.value;
      setState((s) => ({ ...s, inputPath: path, requestedPath: path }));
      void loadDirectory(path);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // Only load on blur if the user actually changed the path.
    const path = e.currentTarget.value;
    if (path !== state.requestedPath) {
      setState((s) => ({ ...s, inputPath: path }));
      void loadDirectory(path);
    }
  };

  const breadcrumbs = useMemo(() => {
    const base = state.listing?.path ?? state.inputPath ?? "";
    const normalized = base.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let built = "";
    for (const part of parts) {
      built += `/${part}`;
      out.push({ label: part, path: built });
    }
    return out;
  }, [state.listing, state.inputPath]);

  const breadcrumbRoot = useMemo(() => {
    const current = state.listing?.path ?? state.inputPath;
    return state.roots.find((r) => current.startsWith(r.path.replace(/\/+$/, "") + "/")) ?? state.roots[0];
  }, [state.listing, state.inputPath, state.roots]);

  const titleId = "dp-title";
  const descId = "dp-desc";
  const newFolderInputId = "dp-new-folder";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg",
          "max-sm:fixed max-sm:inset-0 max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-2 max-sm:border-border",
        )}
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <DialogHeader className="px-4 pt-3 pb-2">
          <DialogTitle id={titleId} className="text-sm font-semibold">
            Select workspace
          </DialogTitle>
          <DialogDescription id={descId} className="sr-only">
            Browse directories on the Devin Remote host and choose a workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4 py-2">
          {state.roots.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Workspace roots</span>
              <div className="flex flex-wrap gap-1.5">
                {state.roots.map((root) => (
                  <button
                    key={root.path}
                    type="button"
                    onClick={() => navigateTo(root.path)}
                    className="flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent"
                    title={root.path}
                  >
                    <HardDriveIcon className="size-3.5" />
                    <span className="truncate max-w-[8rem]">{root.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="dp-path" className="text-xs font-medium text-muted-foreground">
              Path
            </label>
            <Input
              id="dp-path"
              ref={inputRef}
              value={state.inputPath}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="tnum font-mono text-xs"
              onChange={(e) => setState((s) => ({ ...s, inputPath: e.target.value }))}
              onKeyDown={handlePathKeyDown}
              onBlur={handleBlur}
              aria-describedby={state.error ? "dp-error" : undefined}
            />
          </div>

          <nav
            aria-label="Breadcrumbs"
            className="flex items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground"
          >
            <button
              type="button"
              className="flex flex-none items-center gap-0.5 rounded p-0.5 hover:text-foreground disabled:opacity-40"
              onClick={navigateUp}
              disabled={!state.listing?.parent}
              aria-label="Parent directory"
              title="Parent directory"
            >
              <ArrowUpIcon className="size-3.5" />
            </button>
            {breadcrumbRoot && (
              <span className="flex flex-none items-center">
                <ChevronRightIcon className="size-3 opacity-50" />
                <button
                  type="button"
                  onClick={() => navigateTo(breadcrumbRoot.path)}
                  className="rounded p-0.5 hover:text-foreground"
                  title={breadcrumbRoot.path}
                >
                  {breadcrumbRoot.label}
                </button>
              </span>
            )}
            {breadcrumbs.map((crumb) => (
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
          aria-busy={state.loading}
          className="min-h-0 flex-1 overflow-y-auto border-y border-border px-2 py-1"
        >
          {state.loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" aria-live="polite">
              <Loader2Icon className="size-4 animate-spin" />
              Loading directories…
            </div>
          )}

          {!state.loading && state.error && (
            <div
              id="dp-error"
              className="py-6 text-center text-xs text-red-500"
              role="alert"
              aria-live="assertive"
            >
              {state.error.message}
            </div>
          )}

          {!state.loading && !state.error && state.roots.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground" role="alert" aria-live="assertive">
              No workspace roots are configured.
            </div>
          )}

          {!state.loading && !state.error && state.listing?.entries.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No directories {state.showHidden ? "" : "(hidden folders are hidden)"}
            </div>
          )}

          {!state.loading &&
            !state.error &&
            state.listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => navigateTo(entry.path)}
                onDoubleClick={() => navigateTo(entry.path)}
              >
                <FolderIcon className="size-4 flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={entry.path}>
                  {entry.name}
                </span>
              </button>
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

            {canCreateFolder && (
              <div className="flex items-center gap-1">
                <Input
                  id={newFolderInputId}
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    setNewNameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreate();
                  }}
                  placeholder="New folder"
                  className="h-8 w-28 px-2 text-xs sm:w-36"
                  aria-invalid={!!newNameError}
                  aria-describedby={newNameError ? "dp-new-folder-error" : undefined}
                />
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={state.creating || !newName.trim()}
                  className="flex h-8 flex-none items-center gap-1 rounded-md bg-secondary px-2 text-xs font-medium text-secondary-foreground hover:bg-accent disabled:opacity-50"
                >
                  {state.creating ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Create
                </button>
              </div>
            )}
          </div>

          {newNameError && (
            <div id="dp-new-folder-error" className="text-xs text-red-500" role="alert" aria-live="assertive">
              {newNameError}
            </div>
          )}

          {!canCreateFolder && !state.loading && !state.error && state.listing && (
            <div className="text-xs text-muted-foreground">
              New folder is not available in this directory.
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={state.listing?.path ?? state.inputPath}
                >
                  {state.listing?.allowed
                    ? shortenPath(state.listing.path)
                    : state.error?.message ?? "No directory loaded"}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="break-all font-mono text-xs">{state.listing?.path ?? state.inputPath}</p>
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
                disabled={!canSelect}
                aria-disabled={!canSelect}
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
