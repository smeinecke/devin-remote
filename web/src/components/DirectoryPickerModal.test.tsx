import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { api } from "../api";

describe("DirectoryPickerModal", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;
  let validateSpy: ReturnType<typeof vi.spyOn>;
  let rootsSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;

  function Wrapper({
    open = true,
    initialPath = "/",
    mode = null,
    worktreeIsolation = false,
    onSelect = vi.fn(),
  }: {
    open?: boolean;
    initialPath?: string;
    mode?: string | null;
    worktreeIsolation?: boolean;
    onSelect?: (path: string) => void;
  }) {
    const [isOpen, setOpen] = useState(open);
    return (
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={isOpen}
          onOpenChange={setOpen}
          initialPath={initialPath}
          mode={mode}
          worktreeIsolation={worktreeIsolation}
          onSelect={(p) => {
            onSelect(p);
            setOpen(false);
          }}
        />
      </TooltipProvider>
    );
  }

  beforeEach(() => {
    cleanup();
    rootsSpy = vi.spyOn(api, "filesystemRoots").mockResolvedValue({
      roots: [{ path: "/home/calvin", label: "Home" }],
    });
    validateSpy = vi.spyOn(api, "validateDirectory").mockImplementation(async (path: string) => ({
      input: path,
      resolvedPath: path,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    }));
    listSpy = vi.spyOn(api, "listDirectories").mockImplementation(async (path: string, hidden?: boolean) => {
      const entries = [
        { name: "projects", path: `${path}/projects`, hidden: false, readable: true, writable: true },
        { name: ".hidden", path: `${path}/.hidden`, hidden: true, readable: true, writable: true },
      ];
      return {
        path,
        parent: path === "/home/calvin" ? null : "/home/calvin",
        entries: hidden ? entries : entries.filter((e) => !e.hidden),
        allowed: true,
        writable: true,
      };
    });
    createSpy = vi.spyOn(api, "createDirectory").mockImplementation(async (path: string) => ({
      input: path,
      resolvedPath: path,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it("falls back to the first root when the initial path is invalid", async () => {
    validateSpy.mockResolvedValue({
      input: "/invalid",
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "OUTSIDE_ALLOWED_ROOT",
    });

    render(<Wrapper initialPath="/invalid" />);

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith("/home/calvin", false);
    });
  });

  it("loads the initial path when it is valid", async () => {
    render(<Wrapper initialPath="/home/calvin/projects" />);

    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledWith("/home/calvin/projects");
      expect(listSpy).toHaveBeenCalledWith("/home/calvin/projects", false);
    });
  });

  it("ignores out-of-order directory responses", async () => {
    let resolveSecond: (value: any) => void = () => {};
    let resolveFirst: (value: any) => void = () => {};

    listSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          const path = listSpy.mock.calls.at(-1)?.[0] as string;
          if (path.includes("first")) {
            resolveFirst = resolve;
          } else {
            resolveSecond = resolve;
          }
        }),
    );

    render(<Wrapper initialPath="/home/calvin/first" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    // Trigger a second navigation before the first response resolves.
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/home/calvin/second" } });
    fireEvent.keyDown(screen.getByLabelText("Path"), { key: "Enter", code: "Enter" });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith("/home/calvin/second", false));

    resolveFirst({
      path: "/home/calvin/first",
      parent: "/home/calvin",
      entries: [],
      allowed: true,
      writable: true,
    });
    resolveSecond({
      path: "/home/calvin/second",
      parent: "/home/calvin",
      entries: [{ name: "result", path: "/home/calvin/second/result", hidden: false, readable: true, writable: true }],
      allowed: true,
      writable: true,
    });

    await waitFor(() => {
      expect(screen.getByText("result")).not.toBeNull();
    });
  });

  it("toggles hidden folders and reloads the current directory", async () => {
    render(<Wrapper initialPath="/home/calvin" />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());
    expect(screen.queryByText(".hidden")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Hidden/i }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith("/home/calvin", true);
    });
  });

  it("disables parent navigation at the root boundary", async () => {
    render(<Wrapper initialPath="/home/calvin" />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    const parent = screen.getByLabelText("Parent directory") as HTMLButtonElement;
    expect(parent.disabled).toBe(true);
  });

  it("selects the canonical loaded path", async () => {
    const onSelect = vi.fn();
    listSpy.mockResolvedValue({
      path: "/home/calvin/projects",
      parent: "/home/calvin",
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<Wrapper initialPath="/home/calvin/projects" onSelect={onSelect} />);
    await waitFor(() => expect((screen.getByRole("button", { name: /Select folder/i }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /Select folder/i }));
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/home/calvin/projects");
    });
  });

  it("does not select a path that has not loaded", async () => {
    const onSelect = vi.fn();
    listSpy.mockResolvedValue({
      path: "/home/calvin",
      parent: null,
      entries: [{ name: "projects", path: "/home/calvin/projects", hidden: false, readable: true, writable: true }],
      allowed: true,
      writable: true,
    });

    render(<Wrapper initialPath="/home/calvin" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    // Change the path input without loading.
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/home/calvin/other" } });

    const select = screen.getByRole("button", { name: /Select folder/i }) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    fireEvent.click(select);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("creates a folder in the current directory", async () => {
    listSpy.mockResolvedValue({
      path: "/home/calvin/projects",
      parent: "/home/calvin",
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<Wrapper initialPath="/home/calvin/projects" />);
    await waitFor(() => expect(screen.queryByText("Loading directories…")).toBeNull());

    const input = screen.getByPlaceholderText("New folder");
    fireEvent.change(input, { target: { value: "new-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith("/home/calvin/projects/new-dir");
    });
  });

  it("disables New folder when the current directory is not writable", async () => {
    listSpy.mockResolvedValue({
      path: "/home/calvin/projects",
      parent: "/home/calvin",
      entries: [],
      allowed: true,
      writable: false,
    });

    render(<Wrapper initialPath="/home/calvin/projects" />);
    await waitFor(() => expect(screen.queryByText("Loading directories…")).toBeNull());

    expect(screen.queryByPlaceholderText("New folder")).toBeNull();
  });
});

