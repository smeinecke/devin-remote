import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, ApiResponseError, directoryListingFromError, directoryValidationFromError, isFilesystemPayload } from "./api";

class FakeResponse {
  ok = false;
  status = 0;
  private body: unknown;

  constructor(ok: boolean, status: number, body: unknown) {
    this.ok = ok;
    this.status = status;
    this.body = body;
  }

  async json() {
    return this.body;
  }
}

describe("api request helper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns parsed JSON for 200 responses", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        input: "/workspace",
        resolvedPath: "/workspace",
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
      }) as unknown as Response,
    );

    const result = await api.validateDirectory("/workspace");
    expect(result.allowed).toBe(true);
  });

  it("preserves typed filesystem payload on non-2xx responses", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(false, 403, {
        input: "/escape",
        resolvedPath: "/escape",
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: false,
        gitRepository: false,
        branch: null,
        errorCode: "SYMLINK_ESCAPE",
      }) as unknown as Response,
    );

    await expect(api.validateDirectory("/escape")).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiResponseError)) return false;
      expect(err.status).toBe(403);
      const payload = directoryValidationFromError(err);
      expect(payload?.errorCode).toBe("SYMLINK_ESCAPE");
      return true;
    });
  });

  it("falls back to a generic error for non-JSON failures", async () => {
    const response = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response as unknown as Response);

    await expect(api.validateDirectory("/broken")).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiResponseError)) return false;
      expect(err.status).toBe(500);
      expect(err.payload).toBeNull();
      return true;
    });
  });

  it("uses the server error message when available", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(false, 400, { error: "bad request body" }) as unknown as Response,
    );

    await expect(api.validateDirectory("/bad")).rejects.toThrow("bad request body");
    await expect(api.validateDirectory("/bad")).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiResponseError)) return false;
      expect(err.status).toBe(400);
      return true;
    });
  });

  it("identifies filesystem payloads and rejects unrelated objects", () => {
    expect(isFilesystemPayload({ allowed: false, errorCode: "OUTSIDE_ALLOWED_ROOT" })).toBe(true);
    expect(isFilesystemPayload({ allowed: true, entries: [] })).toBe(true);
    expect(isFilesystemPayload({ error: "boom" })).toBe(false);
    expect(isFilesystemPayload(null)).toBe(false);
    expect(isFilesystemPayload([1, 2, 3])).toBe(false);
  });

  it("extracts a DirectoryListingResponse from an ApiResponseError", () => {
    const payload: any = {
      path: "/workspace",
      parent: null,
      root: { path: "/workspace", label: "workspace" },
      breadcrumbs: [],
      entries: [],
      allowed: false,
      writable: false,
      errorCode: "OUTSIDE_ALLOWED_ROOT",
    };
    const err = new ApiResponseError("Forbidden", 403, payload);
    const listing = directoryListingFromError(err);
    expect(listing?.errorCode).toBe("OUTSIDE_ALLOWED_ROOT");
    expect(directoryListingFromError(new Error("plain"))).toBeNull();
  });

  it("extracts a DirectoryValidationResponse from an ApiResponseError", () => {
    const payload: any = {
      input: "/workspace",
      resolvedPath: null,
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      allowed: false,
      gitRepository: false,
      branch: null,
      errorCode: "PATH_NOT_FOUND",
    };
    const err = new ApiResponseError("Not found", 404, payload);
    expect(directoryValidationFromError(err)?.errorCode).toBe("PATH_NOT_FOUND");
    expect(directoryValidationFromError(new Error("plain"))).toBeNull();
  });
});
