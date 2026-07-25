import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./Sidebar";
import * as state from "../state";

const HOME = process.env.HOME ?? "/tmp";

vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();
  return { ...actual, useStore: vi.fn() };
});

describe("Sidebar", () => {
  beforeEach(() => {
    cleanup();
    vi.spyOn(state, "useStore").mockReturnValue({
      meta: {
        primaryCwd: null,
        workspaces: [`${HOME}/base`],
      },
      sessions: {
        s1: {
          sessionId: "s1",
          cwd: "/tmp/generated-worktree",
          worktree: "/tmp/generated-worktree",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      },
      sessionsLoading: false,
      activeSessionId: null,
      ui: { sidebarOpen: true },
      settings: { defaultMode: "ask", worktreeIsolation: false },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("uses meta.workspaces for the recent dropdown and excludes generated worktree sessions", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Recent/i }));

    expect(screen.getByText("base")).not.toBeNull();
    expect(screen.queryByText("generated-worktree")).toBeNull();
  });
});
