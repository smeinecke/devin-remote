import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { DirectoryValidationResponse } from "../types";
import { basename, shortenPath } from "../utils";
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
  disabled?: boolean;
  onValidationChange?: (result: DirectoryValidationResponse | null) => void;
}

export default function WorkspacePathField({
  value,
  onChange,
  recentPaths = [],
  primaryCwd,
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

  // Default the input to the primary cwd when the field is empty on first render.
  useEffect(() => {
    if (!defaultedRef.current && !value && primaryCwd) {
      defaultedRef.current = true;
      onChange(primaryCwd);
    }
  }, [value, primaryCwd, onChange]);

  const runValidate = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        setValidation(null);
        onValidationChange?.(null);
        return;
      }
      setValidating(true);
      try {
        const result = await api.validateDirectory(path);
        setValidation(result);
        onValidationChange?.(result);
      } catch (err) {
        const result: DirectoryValidationResponse = {
          input: path,
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
        setValidation(result);
        onValidationChange?.(result);
      } finally {
        setValidating(false);
      }
    },
    [onValidationChange],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runValidate(value);
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

  const display = useMemo(() => {
    if (!value) return "";
    return shortenPath(value);
  }, [value]);

  const status = validationStatus(validation);
  const canCreate = validation?.allowed && validation.exists && validation.isDirectory && validation.readable;

  const handleSelectRecent = (path: string) => {
    onChange(path);
    setRecentOpen(false);
    void runValidate(path);
  };

  const handlePickerSelect = (path: string) => {
    onChange(path);
    setTouched(true);
    void runValidate(path);
  };

  const handleBlur = () => {
    setTouched(true);
    void runValidate(value);
  };

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
            onChange={(e) => {
              onChange(e.target.value);
              setTouched(false);
            }}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setTouched(true);
                void runValidate(value);
              }
            }}
            placeholder={primaryCwd ?? "/path/to/workspace"}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
            className="tnum h-9 w-full min-w-0 border-transparent bg-secondary pr-8 font-mono text-xs shadow-none focus-visible:border-input"
            title={value || primaryCwd || ""}
          />
          {validating && (
            <Loader2Icon className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
          {!validating && validation && (
            <span
              className={cn(
                "absolute right-2.5 top-1/2 -translate-y-1/2 text-xs",
                canCreate ? "text-emerald-500" : "text-amber-500",
              )}
              title={validation.resolvedPath ?? validation.input}
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
        <div className="flex items-center gap-1.5 text-xs" aria-live="polite">
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
              <p className="break-all font-mono text-xs">{validation?.resolvedPath ?? value}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      <DirectoryPickerModal
        open={open}
        onOpenChange={setOpen}
        initialPath={validation?.resolvedPath ?? value ?? primaryCwd ?? "/"}
        onSelect={handlePickerSelect}
      />
    </div>
  );
}

function validationStatus(result: DirectoryValidationResponse | null): string | null {
  if (!result) return null;
  if (!result.allowed) {
    if (result.errorCode === "OUTSIDE_ALLOWED_ROOT") return "Outside configured workspace roots";
    if (result.errorCode === "PATH_NOT_FOUND") return "Directory does not exist";
    if (result.errorCode === "NOT_A_DIRECTORY") return "Not a directory";
    if (result.errorCode === "PERMISSION_DENIED") return "Permission denied";
    if (result.errorCode === "SYMLINK_ESCAPE") return "Symlink escapes workspace roots";
    if (result.errorCode === "INVALID_PATH") return "Invalid path";
    return result.errorCode ?? "Invalid workspace";
  }
  if (!result.exists) return "Directory will be created?"; // Not used in create flow.
  const parts: string[] = [];
  parts.push("Directory exists");
  if (result.gitRepository) parts.push(`Git repository · ${result.branch ?? "unknown branch"}`);
  if (result.readable) parts.push("Readable");
  if (result.writable) parts.push("Writable");
  if (!result.writable) parts.push("Read-only");
  return parts.join(" · ");
}
