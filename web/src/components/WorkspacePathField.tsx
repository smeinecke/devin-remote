import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, directoryValidationFromError, InvalidApiPayloadError } from "../api";
import type { DirectoryValidationResponse } from "../types";
import { basename, shortenPath, workspaceMeetsModeRequirements, validationErrorMessage } from "../utils";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { CheckIcon, ChevronDownIcon, FolderSearchIcon, Loader2Icon, XIcon } from "lucide-react";

const DEFAULT_INVALID: DirectoryValidationResponse = {
  input: "",
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
  const validationRef = useRef(validation);
  const activeValidationRef = useRef<{
    input: string;
    sequence: number;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    validationRef.current = validation;
  }, [validation]);

  const clearValidation = useCallback(() => {
    validationRef.current = null;
    setValidation(null);
    onValidationChange?.(null);
    lastValidatedInputRef.current = null;
  }, [onValidationChange]);

  const applyValidation = useCallback(
    (result: DirectoryValidationResponse | null, inputAtStart: string) => {
      if (inputAtStart !== valueRef.current) return;
      validationRef.current = result;
      setValidation(result);
      onValidationChange?.(result);
      if (result) {
        lastValidatedInputRef.current = inputAtStart;
      }
    },
    [onValidationChange],
  );

  const runValidate = useCallback(
    async (input: string, options?: { force?: boolean }) => {
      const normalizedInput = input;

      const active = activeValidationRef.current;
      if (
        !options?.force &&
        active &&
        active.input === normalizedInput &&
        normalizedInput === valueRef.current
      ) {
        return active.promise;
      }

      if (
        !options?.force &&
        lastValidatedInputRef.current === normalizedInput &&
        validationRef.current?.input === normalizedInput
      ) {
        return;
      }

      const sequence = ++validationSeq.current;

      if (!normalizedInput.trim()) {
        if (sequence !== validationSeq.current) return;
        setValidating(false);
        applyValidation(null, normalizedInput);
        return;
      }

      const perform = async () => {
        setValidating(true);
        try {
          const result = await api.validateDirectory(normalizedInput);
          if (sequence !== validationSeq.current) return;
          applyValidation(result, normalizedInput);
        } catch (err) {
          if (sequence !== validationSeq.current) return;
          const payload = directoryValidationFromError(err);
          const result: DirectoryValidationResponse = payload ?? {
            ...DEFAULT_INVALID,
            input: normalizedInput,
          };
          if (err instanceof InvalidApiPayloadError) {
            result.errorCode = "INVALID_API_RESPONSE";
          }
          applyValidation(result, normalizedInput);
        } finally {
          if (activeValidationRef.current?.sequence === sequence) {
            activeValidationRef.current = null;
          }
          if (validationSeq.current === sequence) {
            setValidating(false);
          }
        }
      };

      const promise = perform();
      activeValidationRef.current = { input: normalizedInput, sequence, promise };
      return promise;
    },
    [applyValidation],
  );

  function validateImmediately(path: string) {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (validationRef.current && validationRef.current.input !== path) {
      clearValidation();
    }

    if (!path.trim()) {
      setValidating(false);
      return;
    }

    void runValidate(path);
  }

  const commitPathValue = useCallback(
    (
      next: string,
      options?: {
        touched?: boolean;
        validate?: boolean;
      },
    ) => {
      if (next !== valueRef.current) {
        valueRef.current = next;
        ++validationSeq.current;
        lastValidatedInputRef.current = null;

        if (activeValidationRef.current && activeValidationRef.current.input !== next) {
          activeValidationRef.current = null;
        }

        clearValidation();
        onChange(next);
      }

      if (options?.touched !== undefined) {
        setTouched(options.touched);
      }

      if (options?.validate) {
        validateImmediately(next);
      }
    },
    [onChange, clearValidation],
  );

  useEffect(() => {
    if (!defaultedRef.current && !valueRef.current && primaryCwd) {
      defaultedRef.current = true;
      commitPathValue(primaryCwd, { touched: false, validate: true });
    }
  }, [primaryCwd, commitPathValue]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const current = valueRef.current;
    const stale = validationRef.current && validationRef.current.input !== current;
    if (stale) {
      lastValidatedInputRef.current = null;
      validationRef.current = null;
    }

    setValidation((prev) => (prev && prev.input !== current ? null : prev));

    if (!current.trim()) {
      setValidating(false);
      setValidation(null);
      return;
    }

    if (activeValidationRef.current?.input === current) return;
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
    setRecentOpen(false);
    commitPathValue(path, { touched: true, validate: true });
  };

  const handlePickerSelect = (path: string) => {
    commitPathValue(path, { touched: true, validate: true });
  };

  useEffect(() => {
    if (wasPickerOpenRef.current && !open) {
      browseButtonRef.current?.focus();
    }
    wasPickerOpenRef.current = open;
  }, [open]);

  const handleBlur = () => {
    setTouched(true);
    validateImmediately(valueRef.current);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    if (next === valueRef.current) return;
    commitPathValue(next, { touched: false });
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
                validateImmediately(valueRef.current);
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
