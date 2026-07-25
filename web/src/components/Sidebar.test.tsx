import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "./Sidebar";
import * as state from "../state";
import { api } from "../api";

const HOME = process.env.HOME ?? "/tmp";

vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();
  return { ...actual, useStore: vi.fn(), createSession: vi.fn() };
});

function baseState() {
  return {
    meta: { primaryCwd: `${HOME}/base`, workspaces: [] },
    sessions: {},
    sessionsLoading: false,
    activeSessionId: null,
    ui: { sidebarOpen: true },
    settings: { defaultMode: "ask", worktreeIsolation: false },
  } as any;
}

function validValidation(path: string) {
  return Promise.resolve({
    input: path,
    resolvedPath: path,
    exists: true,
    isDirectory: true,
    readable: true,
    writable: true,
    allowed: true,
    gitRepository: false,
    branch: null,
  });
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    (state.useStore as any).mockReturnValue(baseState());
    (state.createSession as any).mockResolvedValue(null);
    vi.spyOn(api, "validateDirectory").mockImplementation((path: string) => validValidation(path));
    vi.spyOn(api, "listDirectories").mockResolvedValue({
      path: `${HOME}/base`,
      parent: null,
      root: { path: `${HOME}/base`, label: "base" },
      breadcrumbs: [{ label: "base", path: `${HOME}/base` }],
      entries: [],
      allowed: true,
      writable: true,
    });
    vi.spyOn(api, "filesystemRoots").mockResolvedValue({ roots: [{ path: `${HOME}/base`, label: "base" }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("uses meta.workspaces for the recent dropdown and excludes generated worktree sessions", () => {
    (state.useStore as any).mockReturnValue({
      ...baseState(),
      meta: { primaryCwd: null, workspaces: [`${HOME}/base`] },
      sessions: {
        s1: {
          sessionId: "s1",
          cwd: "/tmp/generated-worktree",
          worktree: "/tmp/generated-worktree",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      },
    });
    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Recent/i }));

    expect(screen.getByText("base")).not.toBeNull();
    expect(screen.queryByText("generated-worktree")).toBeNull();
  });

  it("retains the canonical root in the workspace field after successful creation", async () => {
    (state.createSession as any).mockResolvedValue({
      sessionId: "s2",
      cwd: "/worktree",
      root: `${HOME}/base`,
      branch: null,
      worktree: "/worktree",
      processGeneration: 1,
    });

    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: /New session/i }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => {
      expect(state.createSession).toHaveBeenCalledWith(`${HOME}/base`);
    });

    await waitFor(() => {
      const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
      expect(input.value).toBe(`${HOME}/base`);
    });
  });

  it("does not clear the workspace field when creation fails", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: /New session/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(state.createSession).toHaveBeenCalledWith(`${HOME}/base`));

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(input.value).toBe(`${HOME}/base`);
  });

  it("clears the loading state after an unexpected rejection", async () => {
    (state.createSession as any).mockRejectedValue(new Error("boom"));

    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: /New session/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByText("Validating…")).toBeNull());
    expect((screen.getByRole("button", { name: /New session/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows creating a second session from the same workspace without reselecting", async () => {
    (state.createSession as any)
      .mockResolvedValueOnce({
        sessionId: "s-a",
        cwd: "/worktree",
        root: `${HOME}/base`,
        branch: null,
        worktree: "/worktree",
        processGeneration: 1,
      })
      .mockResolvedValueOnce({
        sessionId: "s-b",
        cwd: "/worktree",
        root: `${HOME}/base`,
        branch: null,
        worktree: "/worktree",
        processGeneration: 1,
      });

    render(
      <TooltipProvider delayDuration={0}>
        <Sidebar />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: /New session/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(state.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);

    await waitFor(() => expect(state.createSession).toHaveBeenCalledTimes(2));
    expect(state.createSession).toHaveBeenLastCalledWith(`${HOME}/base`);
  });
});
