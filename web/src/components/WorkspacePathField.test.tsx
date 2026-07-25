import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { useState } from "react";
import WorkspacePathField from "./WorkspacePathField";
import { api } from "../api";
import { TooltipProvider } from "@/components/ui/tooltip";

const HOME = process.env.HOME ?? "/tmp";

describe("WorkspacePathField", () => {
  let validateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanup();
    validateSpy = vi.spyOn(api, "validateDirectory").mockResolvedValue({
      input: "/workspace",
      resolvedPath: "/workspace",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });
    vi.spyOn(api, "listDirectories").mockResolvedValue({
      path: "/",
      parent: null,
      root: { path: "/", label: "Root" },
      breadcrumbs: [{ label: "Root", path: "/" }],
      entries: [],
      allowed: true,
      writable: true,
    });
    vi.spyOn(api, "filesystemRoots").mockResolvedValue({ roots: [{ path: "/", label: "Root" }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function Wrapper(props: {
    value?: string;
    recentPaths?: string[];
    primaryCwd?: string;
    mode?: string;
    worktreeIsolation?: boolean;
    onValidationChange?: (v: any) => void;
  }) {
    const [value, setValue] = useState(props.value ?? "");
    return (
      <TooltipProvider delayDuration={0}>
        <WorkspacePathField
          value={value}
          onChange={setValue}
          recentPaths={props.recentPaths ?? []}
          primaryCwd={props.primaryCwd}
          mode={props.mode}
          worktreeIsolation={props.worktreeIsolation}
          onValidationChange={props.onValidationChange}
        />
      </TooltipProvider>
    );
  }

  it("shows the full path in the input and validates on blur", async () => {
    render(<Wrapper value="/workspace" />);

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(input.value).toBe("/workspace");

    fireEvent.change(input, { target: { value: "/other" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledWith("/other");
    });
  });

  it("displays validation success when the directory is valid", async () => {
    const onValidationChange = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspacePathField
          value="/workspace"
          onChange={vi.fn()}
          recentPaths={[]}
          onValidationChange={onValidationChange}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(onValidationChange).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: true, exists: true, isDirectory: true }),
      );
    });

    expect(screen.getByText("✓")).not.toBeNull();
  });

  it("displays validation failure for an outside-root directory", async () => {
    validateSpy.mockResolvedValue({
      input: "/etc",
      resolvedPath: "/etc",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "OUTSIDE_ALLOWED_ROOT",
    });

    const onValidationChange = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspacePathField
          value="/etc"
          onChange={vi.fn()}
          recentPaths={[]}
          onValidationChange={onValidationChange}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(onValidationChange).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
    });

    expect(screen.getByText("!")).not.toBeNull();
  });

  it("renders recent paths with basename and shortened full path", () => {
    render(<Wrapper recentPaths={[`${HOME}/projects/devin-remote`]} />);

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);

    expect(screen.getByText("devin-remote")).not.toBeNull();
    expect(screen.getByTitle(`${HOME}/projects/devin-remote`)).not.toBeNull();
  });

  it("opens the directory picker when Browse is clicked", async () => {
    render(<Wrapper />);

    const browse = screen.getByRole("button", { name: /Browse/i });
    fireEvent.click(browse);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Select workspace/i })).not.toBeNull();
    });
  });

  it("ignores out-of-order validation responses", async () => {
    let resolveFirst: (value: any) => void = () => {};
    let resolveSecond: (value: any) => void = () => {};
    const onValidationChange = vi.fn();

    validateSpy.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          if (path === "/first") resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );

    render(<Wrapper value="/first" onValidationChange={onValidationChange} />);
    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/second" } });
    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/second"));

    resolveFirst({
      input: "/first",
      resolvedPath: "/first",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    resolveSecond({
      input: "/second",
      resolvedPath: "/second",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    await waitFor(() => {
      expect(onValidationChange).toHaveBeenLastCalledWith(expect.objectContaining({ input: "/second" }));
    });

    const calls = onValidationChange.mock.calls.map((c) => c[0]?.input);
    expect(calls).not.toContain("/first");
  });

  it("selecting a recent path updates the value and revalidates", async () => {
    render(<Wrapper recentPaths={[`${HOME}/projects`]} />);

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);

    const item = screen.getByText("projects");
    fireEvent.click(item);

    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledWith(`${HOME}/projects`);
    });

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(input.value).toBe(`${HOME}/projects`);
  });

  it("allows a read-only directory for ask mode", async () => {
    validateSpy.mockResolvedValue({
      input: "/readonly",
      resolvedPath: "/readonly",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    render(<Wrapper value="/readonly" mode="ask" />);

    await waitFor(() => {
      expect(screen.getByText("✓")).not.toBeNull();
    });
  });

  it("rejects a read-only directory for code mode", async () => {
    validateSpy.mockResolvedValue({
      input: "/readonly",
      resolvedPath: "/readonly",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    render(<Wrapper value="/readonly" mode="accept-edits" />);

    await waitFor(() => {
      expect(screen.getByText("!")).not.toBeNull();
    });
  });
});
