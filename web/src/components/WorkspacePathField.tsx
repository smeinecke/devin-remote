import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, directoryValidationFromError } from "../api";
import type { DirectoryValidationResponse } from "../types";
import { basename, shortenPath, workspaceMeetsModeRequirements, validationErrorMessage } from "../utils";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { CheckIcon, ChevronDownIcon, FolderSearchIcon, Loader2Icon, XIcon } from "lucide-react";

export interface WorkspacePathFieldProps {
  value: string;
  onChange: (value: string) => void;
  recentPaths?: string[];
  primaryCwd?: string | null;
  mode?: string | null;
  worktreeIsolation?: boolean;
  disabled?: boolean;
  onValidationChange?: (result: DirectoryValidationResponse | null) => void;
}

export default function WorkspacePathField({
  value,
  onChange,
  recentPaths = [],
  primaryCwd,
  mode = null,
  worktreeIsolation = false,
  disabled,
  onValidationChange,
}: WorkspacePathFieldProps) {
  const [open, setOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [validation, setValidation] = useState<DirectoryValidationResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [touched, setTouched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultedRef = useRef(false);
  const validationSeq = useRef(0);
  const valueRef = useRef(value);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const wasPickerOpenRef = useRef(false);
  const lastValidatedInputRef = useRef<string | null>(null);
  const activeValidationInputRef = useRef<string | null>(null);
  const validationRef = useRef(validation);
  const validatingRef = useRef(validating);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    validationRef.current = validation;
  }, [validation]);

  useEffect(() => {
    validatingRef.current = validating;
  }, [validating]);

  // Default the input to the primary cwd when the field is empty on first render.
  useEffect(() => {
    if (!defaultedRef.current && !value && primaryCwd) {
      defaultedRef.current = true;
      onChange(primaryCwd);
    }
  }, [value, primaryCwd, onChange]);

  const applyValidation = useCallback(
    (result: DirectoryValidationResponse | null, inputAtStart: string) => {
      if (inputAtStart !== valueRef.current) return;
      setValidation(result);
      onValidationChange?.(result);
      if (result) {
        lastValidatedInputRef.current = inputAtStart;
      }
    },
    [onValidationChange],
  );

  const runValidate = useCallback(
    async (path: string) => {
      const inputAtStart = path;
      const seq = ++validationSeq.current;

      if (inputAtStart === activeValidationInputRef.current && validatingRef.current) return;
      if (
        inputAtStart === lastValidatedInputRef.current &&
        inputAtStart === valueRef.current &&
        validationRef.current?.input === inputAtStart
      ) {
        return;
      }

      if (!inputAtStart.trim()) {
        if (seq !== validationSeq.current) return;
        setValidating(false);
        applyValidation(null, inputAtStart);
        return;
      }

      activeValidationInputRef.current = inputAtStart;
      setValidating(true);
      try {
        const result = await api.validateDirectory(inputAtStart);
        if (seq !== validationSeq.current) return;
        applyValidation(result, inputAtStart);
      } catch (err) {
        if (seq !== validationSeq.current) return;
        const payload = directoryValidationFromError(err);
        const result: DirectoryValidationResponse =
          payload ?? {
            input: inputAtStart,
            resolvedPath: null,
            exists: false,
            isDirectory: false,
            readable: false,
            writable: false,
            allowed: false,
            gitRepository: false,
            branch: null,
            errorCode: "IO_ERROR",
          };
        applyValidation(result, inputAtStart);
      } finally {
        if (seq === validationSeq.current) {
          setValidating(false);
          activeValidationInputRef.current = null;
        }
      }
    },
    [applyValidation],
  );

  function validateImmediately(path: string) {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    valueRef.current = path;
    lastValidatedInputRef.current = null;
    activeValidationInputRef.current = null;
    ++validationSeq.current;
    setValidation(null);
    onValidationChange?.(null);
    void runValidate(path);
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setValidation((prev) => (prev && prev.input !== valueRef.current ? null : prev));

    const current = valueRef.current;
    if (!current.trim()) {
      setValidating(false);
      setValidation(null);
      return;
    }
    if (activeValidationInputRef.current === current) return;
    if (lastValidatedInputRef.current === current && validationRef.current?.input === current) {
      setValidating(false);
      return;
    }

    setValidating(true);
    debounceRef.current = setTimeout(() => {
      void runValidate(current);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, runValidate]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setRecentOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const usableValidation = useMemo(() => {
    if (!validation) return null;
    return validation.input === value ? validation : null;
  }, [validation, value]);

  const check = useMemo(
    () => workspaceMeetsModeRequirements(usableValidation, mode, worktreeIsolation),
    [usableValidation, mode, worktreeIsolation],
  );

  const status = useMemo(() => {
    if (validating) return "Validating…";
    if (!usableValidation) return value ? null : "Enter or select a workspace directory";
    if (check.allowed) {
      const parts: string[] = ["Directory exists"];
      if (usableValidation.gitRepository) {
        parts.push(`Git repository · ${usableValidation.branch ?? "unknown branch"}`);
      }
      if (usableValidation.readable) parts.push("Readable");
      if (usableValidation.writable) parts.push("Writable");
      if (!usableValidation.writable && mode === "ask") parts.push("Read-only (Ask mode allowed)");
      return parts.join(" · ");
    }
    return check.reason ?? validationErrorMessage(usableValidation.errorCode ?? "IO_ERROR");
  }, [validating, usableValidation, check, value, mode]);

  const handleSelectRecent = (path: string) => {
    onChange(path);
    setRecentOpen(false);
    setTouched(true);
    validateImmediately(path);
  };

  const handlePickerSelect = (path: string) => {
    onChange(path);
    setTouched(true);
    validateImmediately(path);
  };

  useEffect(() => {
    if (wasPickerOpenRef.current && !open) {
      browseButtonRef.current?.focus();
    }
    wasPickerOpenRef.current = open;
  }, [open]);

  const handleBlur = () => {
    setTouched(true);
    validateImmediately(value);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    valueRef.current = next;
    onChange(next);
    setTouched(false);
    // A new value immediately invalidates any previous validation.
    ++validationSeq.current;
    lastValidatedInputRef.current = null;
    activeValidationInputRef.current = null;
    setValidation(null);
    onValidationChange?.(null);
  };

  const canCreate = check.allowed;

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <label htmlFor="session-cwd" className="sr-only">
        Workspace path
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Input
            id="session-cwd"
            value={value}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setTouched(true);
                validateImmediately(value);
              }
            }}
            placeholder={primaryCwd ?? "/path/to/workspace"}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
            className="tnum h-9 w-full min-w-0 border-transparent bg-secondary pr-8 font-mono text-xs shadow-none focus-visible:border-input"
            title={value || primaryCwd || ""}
            aria-invalid={touched && !canCreate}
            aria-describedby={touched && status ? "workspace-status" : undefined}
          />
          {validating && (
            <Loader2Icon className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
          {!validating && usableValidation && (
            <span
              className={cn(
                "absolute right-2.5 top-1/2 -translate-y-1/2 text-xs",
                canCreate ? "text-emerald-500" : "text-amber-500",
              )}
              title={usableValidation.resolvedPath ?? usableValidation.input}
            >
              {canCreate ? "✓" : "!"}
            </span>
          )}
        </div>

        <div className="flex gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setRecentOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={recentOpen}
              className="flex h-9 flex-none items-center gap-1 rounded-lg bg-secondary px-2.5 text-xs font-medium text-secondary-foreground hover:bg-accent"
            >
              Recent
              <ChevronDownIcon className="size-3.5" />
            </button>
            {recentOpen && (
              <div
                role="listbox"
                aria-label="Recent workspaces"
                className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg sm:w-72"
              >
                {recentPaths.length === 0 && (
                  <div className="px-2 py-2 text-xs text-muted-foreground">No recent workspaces</div>
                )}
                {recentPaths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="option"
                    aria-selected={p === value}
                    onClick={() => handleSelectRecent(p)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{basename(p)}</div>
                      <div className="truncate text-[10px] text-muted-foreground" title={p}>
                        {shortenPath(p)}
                      </div>
                    </div>
                    {p === value && <CheckIcon className="size-3.5 flex-none text-primary" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            ref={browseButtonRef}
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="flex h-9 flex-none items-center gap-1.5 rounded-lg bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-accent active:scale-[0.98] disabled:opacity-50"
          >
            <FolderSearchIcon className="size-3.5" />
            Browse…
          </button>
        </div>
      </div>

      {touched && status && (
        <div
          id="workspace-status"
          className="flex items-center gap-1.5 text-xs"
          aria-live="polite"
        >
          {canCreate ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <XIcon className="size-3.5 text-amber-500" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("truncate", canCreate ? "text-emerald-600" : "text-amber-600")}>
                {status}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="break-all font-mono text-xs">
                {(usableValidation?.resolvedPath ?? value) || primaryCwd || ""}
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      <DirectoryPickerModal
        open={open}
        onOpenChange={setOpen}
        initialPath={usableValidation?.resolvedPath ?? value ?? primaryCwd ?? "/"}
        mode={mode}
        worktreeIsolation={worktreeIsolation}
        onSelect={handlePickerSelect}
      />
    </div>
  );
}
