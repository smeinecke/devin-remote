import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, directoryListingFromError, directoryValidationFromError } from "../api";
import type { DirectoryListingResponse, FilesystemRoot } from "../types";
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
  loadedPath: string | null;
  listing: DirectoryListingResponse | null;
  roots: FilesystemRoot[];
  rootsLoading: boolean;
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
    loadedPath: null,
    listing: null,
    roots: [],
    rootsLoading: false,
    loading: false,
    creating: false,
    showHidden: false,
    error: null,
  });
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState<string | null>(null);

  const modalEpochRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const createSequenceRef = useRef(0);
  const showHiddenRef = useRef(false);
  const requestedPathRef = useRef(initialPath);
  const wasOpenRef = useRef(false);
  const isCreatingRef = useRef(false);

  const loadDirectory = useCallback(
    async (
      requestedPath: string,
      options?: { showHidden?: boolean; modalEpoch?: number },
    ) => {
      const seq = ++loadSequenceRef.current;
      const capturedEpoch = options?.modalEpoch ?? modalEpochRef.current;
      const showHidden = options?.showHidden ?? showHiddenRef.current;

      if (capturedEpoch !== modalEpochRef.current) return;
      requestedPathRef.current = requestedPath;

      setState((s) => ({
        ...s,
        inputPath: requestedPath,
        requestedPath: requestedPath,
        loading: true,
        error: null,
        listing: null,
      }));

      try {
        const listing = await api.listDirectories(requestedPath, showHidden);
        if (seq !== loadSequenceRef.current || capturedEpoch !== modalEpochRef.current) return;

        const error: PickerError | null = listing.errorCode
          ? { code: listing.errorCode, message: validationErrorMessage(listing.errorCode) }
          : null;

        setState((s) => ({
          ...s,
          inputPath: listing.path,
          requestedPath: listing.path,
          loadedPath: listing.path,
          listing,
          loading: false,
          error,
        }));
      } catch (err) {
        if (seq !== loadSequenceRef.current || capturedEpoch !== modalEpochRef.current) return;

        const listing = directoryListingFromError(err);
        if (listing) {
          const error: PickerError | null = listing.errorCode
            ? { code: listing.errorCode, message: validationErrorMessage(listing.errorCode) }
            : null;
          setState((s) => ({
            ...s,
            inputPath: listing.path,
            requestedPath: listing.path,
            loadedPath: listing.path,
            listing,
            loading: false,
            error,
          }));
          return;
        }

        setState((s) => ({
          ...s,
          listing: null,
          loading: false,
          error: {
            code: "DIRECTORY_LOAD_FAILED",
            message: validationErrorMessage("DIRECTORY_LOAD_FAILED"),
          },
        }));
      }
    },
    [],
  );

  const initialize = useCallback(
    async (epoch: number, preferred: string) => {
      if (epoch !== modalEpochRef.current) return;

      loadSequenceRef.current++;

      setState((s) => ({
        ...s,
        inputPath: preferred,
        requestedPath: preferred,
        loadedPath: null,
        rootsLoading: true,
        loading: true,
        error: null,
        listing: null,
      }));

      let roots: FilesystemRoot[] = [];
      try {
        const res = await api.filesystemRoots();
        roots = res.roots;
      } catch (err) {
        if (epoch !== modalEpochRef.current) return;
        setState((s) => ({
          ...s,
          rootsLoading: false,
          loading: false,
          error: {
            code: "ROOTS_REQUEST_FAILED",
            message: validationErrorMessage("ROOTS_REQUEST_FAILED"),
          },
        }));
        return;
      }

      if (epoch !== modalEpochRef.current) return;

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
          if (epoch !== modalEpochRef.current) return;
          if (validation.allowed && validation.resolvedPath) {
            await loadDirectory(validation.resolvedPath, { modalEpoch: epoch });
            return;
          }
        } catch {
          // fall through to first root
        }
        if (epoch !== modalEpochRef.current) return;
      }

      await loadDirectory(roots[0].path, { modalEpoch: epoch });
    },
    [loadDirectory],
  );

  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current) {
        const epoch = ++modalEpochRef.current;
        setNewName("");
        setNewNameError(null);
        requestedPathRef.current = initialPath;
        void initialize(epoch, initialPath);
      }
    } else {
      // Closing invalidates any in-flight work for this modal instance.
      modalEpochRef.current++;
      loadSequenceRef.current++;
      createSequenceRef.current++;
      isCreatingRef.current = false;
      setState((s) => ({ ...s, loading: false, creating: false }));
    }
    wasOpenRef.current = open;
  }, [open, initialPath, initialize]);

  const navigateTo = useCallback(
    (target: string) => {
      void loadDirectory(target);
    },
    [loadDirectory],
  );

  const navigateUp = useCallback(() => {
    const parent = state.listing?.parent;
    if (parent) void loadDirectory(parent);
  }, [state.listing, loadDirectory]);

  const handleRefresh = useCallback(() => {
    const current = requestedPathRef.current || state.loadedPath || state.inputPath;
    if (current) void loadDirectory(current);
  }, [state.loadedPath, state.inputPath, loadDirectory]);

  const handleRetry = useCallback(() => {
    const code = state.error?.code;
    if (code === "ROOTS_REQUEST_FAILED" || code === "NO_WORKSPACE_ROOTS") {
      const epoch = ++modalEpochRef.current;
      void initialize(epoch, state.inputPath ?? initialPath);
    } else {
      const current = requestedPathRef.current || state.loadedPath || state.inputPath;
      if (current) void loadDirectory(current);
    }
  }, [state.error, state.inputPath, state.loadedPath, initialPath, initialize, loadDirectory]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setNewNameError("Invalid folder name");
      return;
    }

    const parentPath = state.listing?.path;
    if (!parentPath || !state.listing?.writable || state.creating) {
      setNewNameError("Cannot create folder here");
      return;
    }

    if (isCreatingRef.current) return;
    isCreatingRef.current = true;

    const createSeq = ++createSequenceRef.current;
    const capturedEpoch = modalEpochRef.current;

    setState((s) => ({ ...s, creating: true }));
    setNewNameError(null);

    try {
      const result = await api.createDirectory({ parentPath, name });
      if (createSeq !== createSequenceRef.current || capturedEpoch !== modalEpochRef.current) return;

      if (result.allowed && result.exists && result.isDirectory && !result.errorCode) {
        setNewName("");
        await loadDirectory(parentPath, { modalEpoch: capturedEpoch });
        if (createSeq !== createSequenceRef.current || capturedEpoch !== modalEpochRef.current) return;
        isCreatingRef.current = false;
        setState((s) => ({ ...s, creating: false }));
      } else {
        isCreatingRef.current = false;
        setState((s) => ({ ...s, creating: false }));
        setNewNameError(validationErrorMessage(result.errorCode ?? "IO_ERROR"));
      }
    } catch (err) {
      if (createSeq !== createSequenceRef.current || capturedEpoch !== modalEpochRef.current) return;
      const payload = directoryValidationFromError(err);
      const code = payload?.errorCode ?? "IO_ERROR";
      setNewNameError(validationErrorMessage(code));
      isCreatingRef.current = false;
      setState((s) => ({ ...s, creating: false }));
    }
  }, [newName, state.listing, loadDirectory]);

  const canSelect = useMemo(() => {
    if (state.loading || state.creating) return false;
    if (state.error || !state.listing) return false;
    if (!state.listing.allowed || !state.listing.path) return false;
    if (state.listing.errorCode) return false;
    if (state.inputPath !== state.requestedPath) return false;
    if (state.listing.path !== state.requestedPath) return false;
    if (state.loadedPath !== state.requestedPath) return false;
    const needsWritable = worktreeIsolation || mode !== "ask";
    if (needsWritable && !state.listing.writable) return false;
    return true;
  }, [state, mode, worktreeIsolation]);

  const canCreateFolder = useMemo(() => {
    if (state.loading) return false;
    if (state.error || !state.listing) return false;
    if (state.listing.errorCode) return false;
    if (state.listing.path !== state.requestedPath) return false;
    if (state.loadedPath !== state.requestedPath) return false;
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
    const path = e.currentTarget.value;
    if (path !== state.requestedPath) {
      setState((s) => ({ ...s, inputPath: path, requestedPath: path }));
      void loadDirectory(path);
    }
  };

  function handleHiddenToggle() {
    const next = !showHiddenRef.current;
    showHiddenRef.current = next;

    setState((current) => ({
      ...current,
      showHidden: next,
    }));

    const target = requestedPathRef.current || state.listing?.path || state.inputPath;
    if (target) {
      void loadDirectory(target, { showHidden: next, modalEpoch: modalEpochRef.current });
    }
  }

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

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {state.listing?.allowed
            ? `Loaded directory ${state.listing.path}`
            : state.error?.message ?? "No directory loaded"}
        </div>

        <div className="flex flex-col gap-3 px-4 py-2">
          {state.roots.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Workspace roots</span>
              <div className="flex flex-wrap gap-1.5" role="list" aria-label="Workspace roots">
                {state.roots.map((root) => (
                  <button
                    key={root.path}
                    type="button"
                    role="listitem"
                    onClick={() => navigateTo(root.path)}
                    className="flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent"
                    title={root.path}
                    aria-label={`Workspace root ${root.label}`}
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
              value={state.inputPath}
              autoFocus
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
            {state.listing?.breadcrumbs.map((crumb) => (
              <span key={crumb.path} className="flex flex-none items-center">
                <ChevronRightIcon className="size-3 opacity-50" />
                <button
                  type="button"
                  onClick={() => navigateTo(crumb.path)}
                  className="max-w-[6rem] truncate rounded p-0.5 hover:text-foreground sm:max-w-[10rem]"
                  title={crumb.path}
                  aria-label={`Breadcrumb ${crumb.label}`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        </div>

        <div
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
              className="flex flex-col items-center gap-2 py-6 text-center text-xs"
              role="alert"
              aria-live="assertive"
            >
              <span className={state.error.code === "NO_WORKSPACE_ROOTS" ? "text-muted-foreground" : "text-red-500"}>
                {state.error.message}
              </span>
              {state.error.code !== "NO_WORKSPACE_ROOTS" && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent"
                  aria-label="Retry"
                >
                  Retry
                </button>
              )}
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
                aria-label={`Open folder ${entry.name}`}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => navigateTo(entry.path)}
                title={entry.path}
              >
                <FolderIcon className="size-4 flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))}
        </div>

        <div className="flex flex-col gap-2 px-4 pb-4 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleHiddenToggle}
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
                aria-label="Refresh directory"
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
                  aria-label="Create folder"
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
            <div className="text-xs text-muted-foreground">New folder is not available in this directory.</div>
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
