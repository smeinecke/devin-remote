/**
 * Explicit session lifecycle state machine.
 *
 * Every session operation flows through the coordinator. Invalid transitions
 * are rejected before they reach the ACP process.
 */

export type SessionStatus =
  | "starting"
  | "loading"
  | "idle"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "disconnected"
  | "failed"
  | "closed";

export type ActiveStatus = Exclude<SessionStatus, "closed">;

const transitions: Record<SessionStatus, Record<string, SessionStatus>> = {
  starting: {
    attach: "loading",
    fail: "failed",
    close: "closed",
  },
  loading: {
    loadComplete: "idle",
    fail: "failed",
    close: "closed",
  },
  idle: {
    prompt: "running",
    attach: "idle",
    fail: "failed",
    close: "closed",
  },
  running: {
    permission: "waiting_for_permission",
    cancel: "cancelling",
    complete: "idle",
    fail: "failed",
    close: "closed",
  },
  waiting_for_permission: {
    resolve: "running",
    cancel: "cancelling",
    fail: "failed",
    close: "closed",
  },
  cancelling: {
    cancel: "cancelling",
    complete: "idle",
    fail: "failed",
    close: "closed",
  },
  disconnected: {
    attach: "loading",
    close: "closed",
  },
  failed: {
    close: "closed",
    attach: "loading",
  },
  closed: {},
};

export interface LifecycleError {
  status: number;
  message: string;
}

export function nextStatus(
  current: SessionStatus,
  operation: string,
): { ok: true; next: SessionStatus } | { ok: false; error: LifecycleError } {
  const allowed = transitions[current];
  const next = allowed[operation];
  if (!next) {
    return {
      ok: false,
      error: {
        status: statusFor(current, operation),
        message: `cannot ${operation} while session is ${current}`,
      },
    };
  }
  return { ok: true, next };
}

function statusFor(current: SessionStatus, operation: string): number {
  if (current === "closed") return 410;
  if (operation === "prompt" && current !== "idle") return 409;
  if (operation === "attach" && (current === "running" || current === "waiting_for_permission" || current === "cancelling")) return 409;
  if (operation === "cancel" && current !== "running" && current !== "waiting_for_permission") return 409;
  return 400;
}

export function isActive(status: SessionStatus): boolean {
  return status !== "closed" && status !== "failed" && status !== "disconnected";
}

export function isRunning(status: SessionStatus): boolean {
  return status === "running" || status === "waiting_for_permission" || status === "cancelling";
}
