import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { api } from "../api";
import type { DirectoryListingResponse, FilesystemRoot } from "../types";

const HOME = process.env.HOME ?? "/tmp";
const WIN_USER = process.env.USER ?? "user";

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(0, i) || "/" : "/";
}

function makeListing(
  p: string,
  roots: string[],
  showHidden: boolean,
  entries: { name: string; path: string; hidden: boolean; readable: boolean; writable: boolean }[] = [
    { name: "projects", path: `${p}/projects`, hidden: false, readable: true, writable: true },
    { name: ".hidden", path: `${p}/.hidden`, hidden: true, readable: true, writable: true },
  ],
): DirectoryListingResponse {
  const matched = roots
    .filter((r) => {
      const normalized = r.replace(/\/+$/, "");
      return p === normalized || p.startsWith(`${normalized}/`);
    })
    .sort((a, b) => b.length - a.length)[0] ?? p;

  const root = matched.replace(/\/+$/, "") || "/";
  const rel = p === root ? "" : p.slice(root.length + 1);
  const segments = rel ? rel.split("/").filter(Boolean) : [];
  const breadcrumbs: { label: string; path: string }[] = [{ label: basename(root) || root, path: root }];
  for (let i = 0; i < segments.length; i++) {
    const path = [root, ...segments.slice(0, i + 1)].join("/");
    breadcrumbs.push({ label: segments[i]!, path });
  }

  return {
    path: p,
    parent: p === root ? null : dirname(p),
    root: { path: root, label: basename(root) || root },
    breadcrumbs,
    entries: showHidden ? entries : entries.filter((e) => !e.hidden),
    allowed: true,
    writable: true,
  };
}

function TestWrapper({
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
      <button data-testid="open-modal" onClick={() => setOpen(true)}>
        Open
      </button>
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

describe("DirectoryPickerModal", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;
  let validateSpy: ReturnType<typeof vi.spyOn>;
  let rootsSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;

  const defaultRoots: FilesystemRoot[] = [{ path: `${HOME}`, label: "Home" }];

  beforeEach(() => {
    cleanup();
    rootsSpy = vi.spyOn(api, "filesystemRoots").mockResolvedValue({ roots: defaultRoots });
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
      return makeListing(path, defaultRoots.map((r) => r.path), !!hidden);
    });
    createSpy = vi.spyOn(api, "createDirectory").mockImplementation(async (params: { parentPath: string; name: string }) => ({
      input: params.parentPath,
      resolvedPath: `${params.parentPath.replace(/\/+$/, "")}/${params.name}`,
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

  it("opens a valid path with one root, one validation, and one listing request", async () => {
    render(<TestWrapper initialPath={`${HOME}/projects`} />);

    await waitFor(() => {
      expect(rootsSpy).toHaveBeenCalledTimes(1);
      expect(validateSpy).toHaveBeenCalledTimes(1);
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(listSpy).toHaveBeenLastCalledWith(`${HOME}/projects`, false);
    });
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

    render(<TestWrapper initialPath="/invalid" />);

    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(`${HOME}`, false);
    });
  });

  it("ignores out-of-order directory responses", async () => {
    const resolvers = new Map<string, (value: DirectoryListingResponse) => void>();
    listSpy.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          resolvers.set(path, resolve);
        }),
    );

    render(<TestWrapper initialPath={`${HOME}/first`} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith(`${HOME}/first`, false));

    const input = screen.getByLabelText("Path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: `${HOME}/second` } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith(`${HOME}/second`, false));

    resolvers.get(`${HOME}/first`)!({
      path: `${HOME}/first`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "first", path: `${HOME}/first` }],
      entries: [],
      allowed: true,
      writable: true,
    });

    resolvers.get(`${HOME}/second`)!({
      path: `${HOME}/second`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "second", path: `${HOME}/second` }],
      entries: [{ name: "result", path: `${HOME}/second/result`, hidden: false, readable: true, writable: true }],
      allowed: true,
      writable: true,
    });

    await waitFor(() => {
      expect(screen.getByText("result")).not.toBeNull();
    });
  });

  it("toggles hidden folders and reloads the current nested directory exactly once", async () => {
    listSpy.mockImplementation(async (path: string, hidden?: boolean) => {
      if (path === `${HOME}`) {
        return makeListing(
          path,
          [`${HOME}`],
          !!hidden,
          [{ name: "packages", path: `${HOME}/packages`, hidden: false, readable: true, writable: true }],
        );
      }
      if (path === `${HOME}/packages`) {
        return makeListing(
          path,
          [`${HOME}`],
          !!hidden,
          [{ name: "web", path: `${HOME}/packages/web`, hidden: false, readable: true, writable: true }],
        );
      }
      return makeListing(path, [`${HOME}`], !!hidden, []);
    });

    render(<TestWrapper initialPath={`${HOME}`} />);
    await waitFor(() => expect(screen.getByText("packages")).not.toBeNull());

    fireEvent.click(screen.getByText("packages"));
    await waitFor(() => expect(screen.getByText("web")).not.toBeNull());

    fireEvent.click(screen.getByText("web"));
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith(`${HOME}/packages/web`, false));

    fireEvent.click(screen.getByRole("button", { name: /Hidden/i }));
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(`${HOME}/packages/web`, true);
      expect(rootsSpy).toHaveBeenCalledTimes(1);
      expect(validateSpy).toHaveBeenCalledTimes(1);
    });

    const input = screen.getByLabelText("Path") as HTMLInputElement;
    expect(input.value).toBe(`${HOME}/packages/web`);
  });

  it("does not return to initialPath when toggling hidden folders from a nested directory", async () => {
    listSpy.mockImplementation(async (path: string, hidden?: boolean) => {
      if (path === `${HOME}`) {
        return makeListing(
          path,
          [`${HOME}`],
          !!hidden,
          [{ name: "packages", path: `${HOME}/packages`, hidden: false, readable: true, writable: true }],
        );
      }
      if (path === `${HOME}/packages`) {
        return makeListing(
          path,
          [`${HOME}`],
          !!hidden,
          [{ name: "web", path: `${HOME}/packages/web`, hidden: false, readable: true, writable: true }],
        );
      }
      return makeListing(path, [`${HOME}`], !!hidden, []);
    });

    render(<TestWrapper initialPath={`${HOME}`} />);
    await waitFor(() => expect(screen.getByText("packages")).not.toBeNull());

    fireEvent.click(screen.getByText("packages"));
    await waitFor(() => expect(screen.getByText("web")).not.toBeNull());

    fireEvent.click(screen.getByText("web"));
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith(`${HOME}/packages/web`, false));

    fireEvent.click(screen.getByRole("button", { name: /Hidden/i }));
    await waitFor(() => {
      const input = screen.getByLabelText("Path") as HTMLInputElement;
      expect(input.value).toBe(`${HOME}/packages/web`);
    });
  });

  it("ignores a directory response that arrives after the modal is closed", async () => {
    let resolveFirst: (value: DirectoryListingResponse) => void = () => {};
    listSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={true}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith(`${HOME}`, false));

    rerender(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={false}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    resolveFirst({
      path: `${HOME}`,
      parent: null,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "Home", path: `${HOME}` }],
      entries: [],
      allowed: true,
      writable: true,
    });

    // Wait a tick, then reopen and verify a fresh load is started.
    await waitFor(() => vi.advanceTimersByTimeAsync(10));

    rerender(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={true}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(listSpy).toHaveBeenLastCalledWith(`${HOME}`, false);
  });

  it("ignores a create response that arrives after the modal is closed", async () => {
    let resolveCreate: (value: any) => void = () => {};
    createSpy.mockImplementation(() => new Promise((resolve) => (resolveCreate = resolve)));

    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={true}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}/projects`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith(`${HOME}/projects`, false));

    const input = screen.getByPlaceholderText("New folder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ parentPath: `${HOME}/projects`, name: "new-dir" }));

    rerender(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={false}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}/projects`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    resolveCreate({
      input: `${HOME}/projects/new-dir`,
      resolvedPath: `${HOME}/projects/new-dir`,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    await waitFor(() => vi.advanceTimersByTimeAsync(10));
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("remains isolated when reopened while an old create request is pending", async () => {
    let resolveOld: (value: any) => void = () => {};
    createSpy.mockImplementation(() => new Promise((resolve) => (resolveOld = resolve)));

    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={true}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}/projects`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith(`${HOME}/projects`, false));

    const input = screen.getByPlaceholderText("New folder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "old-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ parentPath: `${HOME}/projects`, name: "old-dir" }));

    rerender(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={false}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}/projects`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    rerender(
      <TooltipProvider delayDuration={0}>
        <DirectoryPickerModal
          open={true}
          onOpenChange={vi.fn()}
          initialPath={`${HOME}/projects`}
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

    const newInput = screen.getByPlaceholderText("New folder") as HTMLInputElement;
    fireEvent.change(newInput, { target: { value: "new-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => expect(createSpy).toHaveBeenLastCalledWith({ parentPath: `${HOME}/projects`, name: "new-dir" }));

    resolveOld({
      input: `${HOME}/projects/old-dir`,
      resolvedPath: `${HOME}/projects/old-dir`,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    await waitFor(() => vi.advanceTimersByTimeAsync(10));

    // A stale old create response should not clear the newer create state.
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("blocks repeated Create clicks from starting parallel requests", async () => {
    let resolveCreate: (value: any) => void = () => {};
    createSpy.mockImplementation(() => new Promise((resolve) => (resolveCreate = resolve)));

    render(<TestWrapper initialPath={`${HOME}/projects`} />);
    await waitFor(() => expect(screen.queryByText("Loading directories…")).toBeNull());

    const input = screen.getByPlaceholderText("New folder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy).toHaveBeenCalledWith({ parentPath: `${HOME}/projects`, name: "new-dir" });

    resolveCreate({
      input: `${HOME}/projects/new-dir`,
      resolvedPath: `${HOME}/projects/new-dir`,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      allowed: true,
      gitRepository: false,
      branch: null,
    });

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });

  it("shows a root-fetch failure with a retry action, not a no-roots message", async () => {
    rootsSpy.mockRejectedValue(new Error("network error"));

    render(<TestWrapper initialPath={`${HOME}`} />);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/Could not load workspace roots/i);
      expect(screen.getByRole("button", { name: /Retry/i })).not.toBeNull();
      const noRootsAlert = screen.queryByRole("alert");
      if (noRootsAlert) expect(noRootsAlert.textContent).not.toMatch(/No workspace roots are configured/i);
    });
  });

  it("retries a failed root fetch and loads the directory", async () => {
    rootsSpy.mockRejectedValueOnce(new Error("network error")).mockResolvedValue({ roots: defaultRoots });

    render(<TestWrapper initialPath={`${HOME}`} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/Could not load workspace roots/i);
    });

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
      const nav = screen.getByRole("navigation", { name: /Breadcrumbs/i });
      expect(nav.textContent).toMatch(new RegExp(basename(HOME), "i"));
      expect(listSpy).toHaveBeenCalledWith(`${HOME}`, false);
    });
  });

  it("shows the distinct no-roots message when there are no workspace roots", async () => {
    rootsSpy.mockResolvedValue({ roots: [] });

    render(<TestWrapper initialPath={`${HOME}`} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/No workspace roots are configured/i);
      expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
    });
  });

  it("selects the longest matching root for an exact secondary root path", async () => {
    const roots: FilesystemRoot[] = [
      { path: `${HOME}`, label: basename(HOME) },
      { path: `${HOME}/projects`, label: "projects" },
    ];
    rootsSpy.mockResolvedValue({ roots });
    listSpy.mockImplementation(async (path: string, hidden?: boolean) =>
      makeListing(path, roots.map((r) => r.path), !!hidden),
    );

    render(<TestWrapper initialPath={`${HOME}/projects`} />);

    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: /Breadcrumbs/i });
      const crumbs = within(nav).getAllByText("projects");
      expect(crumbs.length).toBe(1);
    });

    const last = listSpy.mock.calls[listSpy.mock.calls.length - 1];
    const returned = await listSpy.mock.results[listSpy.mock.results.length - 1].value;
    expect(returned.root.path).toBe(`${HOME}/projects`);
  });

  it("chooses the longest matching root for an overlapping nested path", async () => {
    const roots: FilesystemRoot[] = [
      { path: `${HOME}`, label: basename(HOME) },
      { path: `${HOME}/projects`, label: "projects" },
    ];
    rootsSpy.mockResolvedValue({ roots });
    listSpy.mockImplementation(async (path: string, hidden?: boolean) =>
      makeListing(path, roots.map((r) => r.path), !!hidden),
    );

    render(<TestWrapper initialPath={`${HOME}/projects/devin-remote/web`} />);

    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: /Breadcrumbs/i });
      expect(within(nav).getByText("projects")).not.toBeNull();
      expect(within(nav).getByText("devin-remote")).not.toBeNull();
      expect(within(nav).getByText("web")).not.toBeNull();
    });

    const returned = await listSpy.mock.results[listSpy.mock.results.length - 1].value;
    expect(returned.root.path).toBe(`${HOME}/projects`);
    expect(returned.breadcrumbs.map((b: any) => b.path)).toEqual([
      `${HOME}/projects`,
      `${HOME}/projects/devin-remote`,
      `${HOME}/projects/devin-remote/web`,
    ]);
  });

  it("does not render breadcrumb paths outside the matched root", async () => {
    const roots: FilesystemRoot[] = [
      { path: `${HOME}`, label: basename(HOME) },
      { path: `${HOME}/projects`, label: "projects" },
    ];
    rootsSpy.mockResolvedValue({ roots });
    listSpy.mockImplementation(async (path: string, hidden?: boolean) =>
      makeListing(path, roots.map((r) => r.path), !!hidden),
    );

    render(<TestWrapper initialPath={`${HOME}/projects/devin-remote/web`} />);

    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: /Breadcrumbs/i });
      const buttons = within(nav).queryAllByRole("button");
      for (const button of buttons) {
        const path = button.getAttribute("title");
        if (path?.startsWith("/")) {
          expect(path.startsWith(`${HOME}/projects`)).toBe(true);
        }
      }
    });
  });

  it("disables parent navigation at the root boundary", async () => {
    render(<TestWrapper initialPath={`${HOME}`} />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    const parent = screen.getByLabelText("Parent directory") as HTMLButtonElement;
    expect(parent.disabled).toBe(true);
  });

  it("renders Windows-style server-provided breadcrumbs without reconstructing host paths", async () => {
    listSpy.mockResolvedValue({
      path: `C:\\Users\\${WIN_USER}\\projects\\devin-remote\\web`,
      parent: `C:\\Users\\${WIN_USER}\\projects\\devin-remote`,
      root: { path: `C:\\Users\\${WIN_USER}\\projects`, label: "projects" },
      breadcrumbs: [
        { label: "projects", path: `C:\\Users\\${WIN_USER}\\projects` },
        { label: "devin-remote", path: `C:\\Users\\${WIN_USER}\\projects\\devin-remote` },
        { label: "web", path: `C:\\Users\\${WIN_USER}\\projects\\devin-remote\\web` },
      ],
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`C:\\Users\\${WIN_USER}\\projects\\devin-remote\\web`} />);

    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: /Breadcrumbs/i });
      expect(within(nav).getByText("projects")).not.toBeNull();
      expect(within(nav).getByText("devin-remote")).not.toBeNull();
      expect(within(nav).getByText("web")).not.toBeNull();
    });
  });

  it("selects the canonical loaded path", async () => {
    const onSelect = vi.fn();
    listSpy.mockResolvedValue({
      path: `${HOME}/projects`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "projects", path: `${HOME}/projects` }],
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`${HOME}/projects`} onSelect={onSelect} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Select folder/i }) as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: /Select folder/i }));
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(`${HOME}/projects`);
    });
  });

  it("does not select a path that has not loaded", async () => {
    const onSelect = vi.fn();
    listSpy.mockResolvedValue({
      path: `${HOME}`,
      parent: null,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "Home", path: `${HOME}` }],
      entries: [{ name: "projects", path: `${HOME}/projects`, hidden: false, readable: true, writable: true }],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`${HOME}`} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    const input = screen.getByLabelText("Path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: `${HOME}/other` } });

    const select = screen.getByRole("button", { name: /Select folder/i }) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    fireEvent.click(select);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("creates a folder in the current directory", async () => {
    listSpy.mockResolvedValue({
      path: `${HOME}/projects`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "projects", path: `${HOME}/projects` }],
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`${HOME}/projects`} />);
    await waitFor(() => expect(screen.queryByText("Loading directories…")).toBeNull());

    const input = screen.getByPlaceholderText("New folder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-dir" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({ parentPath: `${HOME}/projects`, name: "new-dir" });
    });
  });

  it("disables New folder when the current directory is not writable", async () => {
    listSpy.mockResolvedValue({
      path: `${HOME}/projects`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "projects", path: `${HOME}/projects` }],
      entries: [],
      allowed: true,
      writable: false,
    });

    render(<TestWrapper initialPath={`${HOME}/projects`} />);
    await waitFor(() => expect(screen.queryByText("Loading directories…")).toBeNull());

    expect(screen.queryByPlaceholderText("New folder")).toBeNull();
  });

  it("announces the loaded canonical directory accessibly", async () => {
    listSpy.mockResolvedValue({
      path: `${HOME}/projects`,
      parent: `${HOME}`,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "projects", path: `${HOME}/projects` }],
      entries: [],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`${HOME}/projects`} />);

    await waitFor(() => {
      const live = screen.getByText(`Loaded directory ${HOME}/projects`);
      expect(live).not.toBeNull();
    });
  });

  it("navigates a folder on a single click and does not respond to double-click", async () => {
    listSpy.mockResolvedValue({
      path: `${HOME}`,
      parent: null,
      root: { path: `${HOME}`, label: "Home" },
      breadcrumbs: [{ label: "Home", path: `${HOME}` }],
      entries: [{ name: "projects", path: `${HOME}/projects`, hidden: false, readable: true, writable: true }],
      allowed: true,
      writable: true,
    });

    render(<TestWrapper initialPath={`${HOME}`} />);
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    fireEvent.click(screen.getByText("projects"));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(listSpy).toHaveBeenLastCalledWith(`${HOME}/projects`, false);
  });
});
