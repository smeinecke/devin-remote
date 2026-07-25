import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  api,
  ApiResponseError,
  directoryListingFromError,
  directoryValidationFromError,
  InvalidApiPayloadError,
  isDirectoryListingResponse,
  isDirectoryValidationResponse,
  isFilesystemRoot,
} from "./api";

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

  it("rejects a validation payload when asked for a listing", () => {
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
    expect(directoryListingFromError(err)).toBeNull();
    expect(directoryValidationFromError(err)?.errorCode).toBe("PATH_NOT_FOUND");
  });

  it("rejects a listing payload when asked for a validation", () => {
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
    expect(directoryValidationFromError(err)).toBeNull();
    expect(directoryListingFromError(err)?.errorCode).toBe("OUTSIDE_ALLOWED_ROOT");
  });

  it("rejects unrelated objects and arrays for both guard types", () => {
    expect(isDirectoryListingResponse({ error: "boom" })).toBe(false);
    expect(isDirectoryListingResponse(null)).toBe(false);
    expect(isDirectoryListingResponse([1, 2, 3])).toBe(false);
    expect(isDirectoryValidationResponse({ error: "boom" })).toBe(false);
    expect(isDirectoryValidationResponse(null)).toBe(false);
    expect(isDirectoryValidationResponse([1, 2, 3])).toBe(false);
  });

  it("requires every listing field in the listing guard", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [],
        entries: [],
        allowed: true,
        writable: true,
      }),
    ).toBe(true);

    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        allowed: true,
        writable: true,
      }),
    ).toBe(false);
  });

  it("requires every validation field in the validation guard", () => {
    expect(
      isDirectoryValidationResponse({
        input: "/workspace",
        resolvedPath: "/workspace",
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
      }),
    ).toBe(true);

    expect(
      isDirectoryValidationResponse({
        input: "/workspace",
        allowed: true,
        errorCode: "PATH_NOT_FOUND",
      }),
    ).toBe(false);
  });

  it("preserves PATH_ALREADY_EXISTS through a 409", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(false, 409, {
        input: "/workspace",
        resolvedPath: "/workspace/existing",
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        allowed: true,
        gitRepository: false,
        branch: null,
        errorCode: "PATH_ALREADY_EXISTS",
      }) as unknown as Response,
    );

    await expect(api.createDirectory({ parentPath: "/workspace", name: "existing" })).rejects.toSatisfy(
      (err: unknown) => {
        if (!(err instanceof ApiResponseError)) return false;
        expect(err.status).toBe(409);
        expect(directoryValidationFromError(err)?.errorCode).toBe("PATH_ALREADY_EXISTS");
        return true;
      },
    );
  });

  it("preserves PATH_NOT_FOUND through a 404", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(false, 404, {
        input: "/workspace/missing",
        resolvedPath: null,
        exists: false,
        isDirectory: false,
        readable: false,
        writable: false,
        allowed: true,
        gitRepository: false,
        branch: null,
        errorCode: "PATH_NOT_FOUND",
      }) as unknown as Response,
    );

    await expect(api.validateDirectory("/workspace/missing")).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiResponseError)) return false;
      expect(err.status).toBe(404);
      expect(directoryValidationFromError(err)?.errorCode).toBe("PATH_NOT_FOUND");
      return true;
    });
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

  it("validates every nested element of a DirectoryListingResponse", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [{ label: "workspace", path: "/workspace" }],
        entries: [
          {
            name: "src",
            path: "/workspace/src",
            hidden: false,
            readable: true,
            writable: true,
          },
        ],
        allowed: true,
        writable: true,
      }),
    ).toBe(true);
  });

  it("rejects a breadcrumb with a missing path", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [{ label: "workspace" }],
        entries: [],
        allowed: true,
        writable: true,
      }),
    ).toBe(false);
  });

  it("rejects a directory entry with a missing writable field", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [],
        entries: [
          {
            name: "src",
            path: "/workspace/src",
            hidden: false,
            readable: true,
          },
        ],
        allowed: true,
        writable: true,
      }),
    ).toBe(false);
  });

  it("rejects an invalid root", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace" },
        breadcrumbs: [],
        entries: [],
        allowed: true,
        writable: true,
      }),
    ).toBe(false);

    expect(isFilesystemRoot({ path: "/workspace" })).toBe(false);
  });

  it("rejects a non-string optional errorCode", () => {
    expect(
      isDirectoryListingResponse({
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [],
        entries: [],
        allowed: true,
        writable: true,
        errorCode: 123,
      }),
    ).toBe(false);

    expect(
      isDirectoryValidationResponse({
        input: "/workspace",
        resolvedPath: null,
        exists: false,
        isDirectory: false,
        readable: false,
        writable: false,
        allowed: false,
        gitRepository: false,
        branch: null,
        errorCode: 123,
      }),
    ).toBe(false);
  });

  it("rejects malformed successful listings with InvalidApiPayloadError", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        path: "/workspace",
        parent: null,
        root: { path: "/workspace" },
        breadcrumbs: [],
        entries: [],
        allowed: true,
        writable: true,
      }) as unknown as Response,
    );

    await expect(api.listDirectories("/workspace")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(InvalidApiPayloadError);
      expect((err as InvalidApiPayloadError).endpoint).toContain("/api/filesystem/directories");
      return true;
    });
  });

  it("rejects malformed successful validation responses with InvalidApiPayloadError", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        input: "/workspace",
        allowed: true,
      }) as unknown as Response,
    );

    await expect(api.validateDirectory("/workspace")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(InvalidApiPayloadError);
      expect((err as InvalidApiPayloadError).endpoint).toBe("/api/filesystem/validate-directory");
      return true;
    });
  });

  it("rejects malformed successful create responses with InvalidApiPayloadError", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        ok: true,
      }) as unknown as Response,
    );

    await expect(api.createDirectory({ parentPath: "/workspace", name: "new" })).rejects.toBeInstanceOf(
      InvalidApiPayloadError,
    );
  });

  it("rejects malformed successful roots responses with InvalidApiPayloadError", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        roots: [{ path: "/workspace" }],
      }) as unknown as Response,
    );

    await expect(api.filesystemRoots()).rejects.toBeInstanceOf(InvalidApiPayloadError);
  });

  it("returns a valid listing response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new FakeResponse(true, 200, {
        path: "/workspace",
        parent: null,
        root: { path: "/workspace", label: "workspace" },
        breadcrumbs: [{ label: "workspace", path: "/workspace" }],
        entries: [
          {
            name: "src",
            path: "/workspace/src",
            hidden: false,
            readable: true,
            writable: true,
          },
        ],
        allowed: true,
        writable: true,
      }) as unknown as Response,
    );

    const listing = await api.listDirectories("/workspace");
    expect(listing.path).toBe("/workspace");
    expect(listing.entries[0]?.name).toBe("src");
  });
});
