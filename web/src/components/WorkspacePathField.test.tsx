import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { useEffect, useState } from "react";
import WorkspacePathField from "./WorkspacePathField";
import { api, InvalidApiPayloadError } from "../api";
import { TooltipProvider } from "@/components/ui/tooltip";

const HOME = process.env.HOME ?? "/tmp";

describe("WorkspacePathField", () => {
  let validateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanup();
    validateSpy = vi.spyOn(api, "validateDirectory").mockImplementation((path: string) =>
      Promise.resolve({
        input: path,
        resolvedPath: path,
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
      }),
    );
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
    useEffect(() => {
      if (props.value !== undefined) {
        setValue(props.value);
      }
    }, [props.value]);
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

  it("coalesces Enter followed by blur into a single validation request", async () => {
    render(<Wrapper value="/workspace" />);

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(validateSpy).toHaveBeenCalledTimes(1));

    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByText("Validating…")).toBeNull());

    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one request for two immediate validations of the same input", async () => {
    render(<Wrapper value="/workspace" />);

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.queryByText("Validating…")).toBeNull());
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("starts a replacement request when the input changes and ignores stale responses", async () => {
    let resolveFirst: (value: any) => void = () => {};
    let resolveSecond: (value: any) => void = () => {};
    const onValidationChange = vi.fn();

    validateSpy.mockImplementation((path: string) =>
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

    expect(validateSpy).toHaveBeenCalledTimes(2);

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

  it("displays the path-not-found message for a missing directory", async () => {
    validateSpy.mockResolvedValue({
      input: "/missing",
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
      errorCode: "PATH_NOT_FOUND",
    });

    render(<Wrapper value="/missing" />);
    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("Directory does not exist.")).not.toBeNull();
      expect(screen.getByText("!")).not.toBeNull();
    });
  });

  it("does not enable creation for a missing workspace", async () => {
    validateSpy.mockResolvedValue({
      input: "/missing",
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: true,
      gitRepository: false,
      branch: null,
      errorCode: "PATH_NOT_FOUND",
    });

    render(<Wrapper value="/missing" />);
    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("!")).not.toBeNull();
    });

    expect(screen.queryByText("✓")).toBeNull();
  });

  it("displays a recent-path validation that resolves immediately", async () => {
    validateSpy.mockImplementation((path: string) =>
      Promise.resolve({
        input: path,
        resolvedPath: path,
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
      }),
    );

    render(<Wrapper recentPaths={[`${HOME}/projects`]} />);

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);
    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => {
      expect(screen.getByText("✓")).not.toBeNull();
    });

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(input.value).toBe(`${HOME}/projects`);
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("starts one validation request for a programmatic selection", async () => {
    render(<Wrapper recentPaths={[`${HOME}/projects`]} />);

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);
    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does not duplicate validation when a recent selection is followed by blur", async () => {
    render(<Wrapper recentPaths={[`${HOME}/projects`]} />);

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);
    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => expect(validateSpy).toHaveBeenCalledTimes(1));

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.blur(input);

    await waitFor(() => expect(screen.queryByText("Validating…")).toBeNull());
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults to primary cwd and validates immediately", async () => {
    render(<Wrapper primaryCwd="/workspace" />);

    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledWith("/workspace");
    });

    await waitFor(() => {
      expect(screen.getByText("✓")).not.toBeNull();
    });
  });

  it("replaces validation when the controlled value changes externally", async () => {
    const { rerender } = render(<Wrapper value="/first" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    rerender(<Wrapper value="/second" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/second"));
  });

  it("ignores a stale validation response after a later programmatic selection", async () => {
    let resolveFirst: (value: any) => void = () => {};
    let resolveSecond: (value: any) => void = () => {};
    const onValidationChange = vi.fn();

    validateSpy.mockImplementation((path: string) =>
      new Promise((resolve) => {
        if (path === "/first") resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
    );

    render(<Wrapper value="/first" onValidationChange={onValidationChange} recentPaths={[`${HOME}/projects`]} />);
    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    const recentBtn = screen.getByRole("button", { name: /Recent/i });
    fireEvent.click(recentBtn);
    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith(`${HOME}/projects`));

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
      input: `${HOME}/projects`,
      resolvedPath: `${HOME}/projects`,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    await waitFor(() => {
      expect(onValidationChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ input: `${HOME}/projects` }),
      );
    });

    const calls = onValidationChange.mock.calls.map((c) => c[0]?.input);
    expect(calls).not.toContain("/first");
  });

  it("displays picker selection validation that resolves immediately", async () => {
    validateSpy.mockImplementation((path: string) =>
      Promise.resolve({
        input: path,
        resolvedPath: path,
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
      }),
    );

    vi.spyOn(api, "filesystemRoots").mockResolvedValue({ roots: [{ path: `${HOME}`, label: "Home" }] });
    vi.spyOn(api, "listDirectories").mockImplementation((path: string) => {
      if (path === `${HOME}/projects`) {
        return Promise.resolve({
          path: `${HOME}/projects`,
          parent: `${HOME}`,
          root: { path: `${HOME}`, label: "Home" },
          breadcrumbs: [
            { label: "Home", path: `${HOME}` },
            { label: "projects", path: `${HOME}/projects` },
          ],
          entries: [],
          allowed: true,
          writable: true,
        });
      }
      return Promise.resolve({
        path: `${HOME}`,
        parent: null,
        root: { path: `${HOME}`, label: "Home" },
        breadcrumbs: [{ label: "Home", path: `${HOME}` }],
        entries: [
          {
            name: "projects",
            path: `${HOME}/projects`,
            hidden: false,
            readable: true,
            writable: true,
          },
        ],
        allowed: true,
        writable: true,
      });
    });

    render(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: /Browse/i }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Select workspace/i })).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByText("projects")).not.toBeNull();
    });

    fireEvent.click(screen.getByText("projects"));
    await waitFor(() => {
      expect(screen.getByText("projects")).not.toBeNull();
      expect(api.listDirectories).toHaveBeenCalledWith(`${HOME}/projects`, false);
    });

    const selectBtn = screen.getByRole("button", { name: /Select folder/i });
    expect((selectBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Select workspace/i })).toBeNull();
    });

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(input.value).toBe(`${HOME}/projects`);
    expect(screen.getByText("✓")).not.toBeNull();
  });

  it("renders a safe message for a malformed server payload", async () => {
    validateSpy.mockRejectedValue(new InvalidApiPayloadError("/api/filesystem/validate-directory", { bad: true }));

    render(<Wrapper value="/workspace" />);
    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("The server returned an invalid directory response.")).not.toBeNull();
    });
  });

  it("does not re-apply the primary cwd while the user intentionally clears the field", async () => {
    render(<Wrapper primaryCwd="/workspace" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/workspace"));

    const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    await waitFor(() => expect(input.value).toBe(""));
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("clears parent validation when the controlled value changes externally", async () => {
    const onValidationChange = vi.fn();
    const { rerender } = render(<Wrapper value="/first" onValidationChange={onValidationChange} />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    rerender(<Wrapper value="/second" onValidationChange={onValidationChange} />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/second"));

    const calls = onValidationChange.mock.calls.map((call) => {
      const v = call[0] as { input?: string } | null;
      return v?.input ?? v;
    });
    expect(calls).toContain(null);
    expect(onValidationChange).toHaveBeenLastCalledWith(expect.objectContaining({ input: "/second" }));
  });

  it("does not duplicate validation during an external value reset", async () => {
    const { rerender } = render(<Wrapper value="/first" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    rerender(<Wrapper value="/second" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/second"));

    const calls = (validateSpy.mock.calls as [string][]).map((call) => call[0]);
    expect(calls.filter((p) => p === "/second").length).toBe(1);
  });

  it("validates the canonical root when the parent sets it after creation", async () => {
    const { rerender } = render(<Wrapper value="/first" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/first"));

    rerender(<Wrapper value="/canonical/root" />);

    await waitFor(() => expect(validateSpy).toHaveBeenCalledWith("/canonical/root"));
    expect(validateSpy).toHaveBeenLastCalledWith("/canonical/root");
  });
});
