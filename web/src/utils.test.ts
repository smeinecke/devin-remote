import { describe, it, expect } from "vitest";
import { basename, dirname, shortenPath, workspaceMeetsModeRequirements, validationErrorMessage } from "./utils";

const HOME = process.env.HOME ?? "/tmp";

describe("path helpers", () => {
  it("extracts basename from unix paths", () => {
    expect(basename(`${HOME}/projects/devin-remote`)).toBe("devin-remote");
    expect(basename("/")).toBe("");
  });

  it("extracts dirname from unix paths", () => {
    expect(dirname(`${HOME}/projects/devin-remote`)).toBe(`${HOME}/projects`);
    expect(dirname("/")).toBe("/");
  });

  it("abbreviates /home/<user> to ~", () => {
    expect(shortenPath(`${HOME}/projects/devin-remote`)).toBe("~/projects/devin-remote");
    expect(shortenPath("/home/alice/workspaces")).toBe("~/workspaces");
  });

  it("preserves basename and meaningful parents for long paths", () => {
    const long = `${HOME}/projects/client/repository/packages/frontend`;
    const out = shortenPath(long, 30);
    expect(out).toContain("packages");
    expect(out).toContain("frontend");
    expect(out).toContain("…");
  });

  it("returns the original short path unchanged", () => {
    expect(shortenPath("/tmp", 40)).toBe("/tmp");
  });

  it("uses the supplied home directory", () => {
    expect(shortenPath("/srv/workspaces/project", 40, "/srv")).toBe("~/workspaces/project");
  });

  it("preserves basename even when extremely long", () => {
    const huge = "/a/" + "b/".repeat(20) + "filename";
    const out = shortenPath(huge, 20);
    expect(out).toContain("filename");
    expect(out.length).toBeLessThanOrEqual(25);
  });
});

function mkValidation(overrides: Partial<ReturnType<typeof workspaceMeetsModeRequirements> & { allowed: boolean; exists: boolean; isDirectory: boolean; readable: boolean; writable: boolean }> = {}) {
  return {
    allowed: true,
    exists: true,
    isDirectory: true,
    readable: true,
    writable: true,
    gitRepository: false,
    branch: null,
    input: "/workspace",
    resolvedPath: "/workspace",
    ...overrides,
  } as any;
}

describe("workspaceMeetsModeRequirements", () => {
  it("allows a writable directory for any mode", () => {
    const v = mkValidation({ writable: true });
    expect(workspaceMeetsModeRequirements(v, "ask").allowed).toBe(true);
    expect(workspaceMeetsModeRequirements(v, "accept-edits").allowed).toBe(true);
    expect(workspaceMeetsModeRequirements(v, "plan").allowed).toBe(true);
  });

  it("allows read-only directories only for ask mode", () => {
    const v = mkValidation({ writable: false });
    expect(workspaceMeetsModeRequirements(v, "ask").allowed).toBe(true);
    expect(workspaceMeetsModeRequirements(v, "accept-edits").allowed).toBe(false);
    expect(workspaceMeetsModeRequirements(v, "plan").allowed).toBe(false);
    expect(workspaceMeetsModeRequirements(v).allowed).toBe(false);
  });

  it("requires writable for ask mode when worktree isolation is enabled", () => {
    const v = mkValidation({ writable: false });
    expect(workspaceMeetsModeRequirements(v, "ask", true).allowed).toBe(false);
    const writable = mkValidation({ writable: true });
    expect(workspaceMeetsModeRequirements(writable, "ask", true).allowed).toBe(true);
  });

  it("rejects invalid validation", () => {
    expect(workspaceMeetsModeRequirements(null, "ask").allowed).toBe(false);
    expect(workspaceMeetsModeRequirements(mkValidation({ allowed: false })).allowed).toBe(false);
    expect(workspaceMeetsModeRequirements(mkValidation({ isDirectory: false })).allowed).toBe(false);
  });
});

describe("validationErrorMessage", () => {
  it("maps known error codes", () => {
    expect(validationErrorMessage("PATH_NOT_FOUND")).toBe("Directory does not exist.");
    expect(validationErrorMessage("OUTSIDE_ALLOWED_ROOT")).toBe("Outside allowed workspace roots.");
    expect(validationErrorMessage("SYMLINK_ESCAPE")).toBe("Symlink escapes workspace roots.");
  });

  it("returns the code for unknown errors", () => {
    expect(validationErrorMessage("UNKNOWN")).toBe("UNKNOWN");
  });
});
