import { describe, it, expect } from "vitest";
import { basename, dirname, shortenPath } from "./utils";

describe("path helpers", () => {
  it("extracts basename from unix paths", () => {
    expect(basename("/home/calvin/projects/devin-remote")).toBe("devin-remote");
    expect(basename("/")).toBe("");
  });

  it("extracts dirname from unix paths", () => {
    expect(dirname("/home/calvin/projects/devin-remote")).toBe("/home/calvin/projects");
    expect(dirname("/")).toBe("/");
  });

  it("abbreviates /home/<user> to ~", () => {
    expect(shortenPath("/home/calvin/projects/devin-remote")).toBe("~/projects/devin-remote");
    expect(shortenPath("/home/alice/workspaces")).toBe("~/workspaces");
  });

  it("preserves basename and meaningful parents for long paths", () => {
    const long = "/home/calvin/projects/client/repository/packages/frontend";
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
