import { describe, it } from "node:test";
import assert from "node:assert";
import { nextStatus } from "../src/lifecycle.js";

describe("lifecycle state machine", () => {
  it("allows idempotent attach from idle", () => {
    const s = nextStatus("idle", "attach");
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.next, "idle");
  });

  it("allows attach from disconnected", () => {
    const s = nextStatus("disconnected", "attach");
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.next, "loading");
  });

  it("allows idle -> prompt -> running -> complete -> idle", () => {
    assert.strictEqual(nextStatus("idle", "prompt").ok, true);
    assert.strictEqual(nextStatus("idle", "prompt").next, "running");
    assert.strictEqual(nextStatus("running", "complete").ok, true);
    assert.strictEqual(nextStatus("running", "complete").next, "idle");
  });

  it("allows cancel idempotently", () => {
    assert.strictEqual(nextStatus("running", "cancel").ok, true);
    assert.strictEqual(nextStatus("cancelling", "cancel").ok, true);
    assert.strictEqual(nextStatus("cancelling", "cancel").next, "cancelling");
  });

  it("rejects prompt while already running", () => {
    const s = nextStatus("running", "prompt");
    assert.strictEqual(s.ok, false);
    assert.equal(s.error?.status, 409);
  });

  it("rejects permission transition from idle", () => {
    const s = nextStatus("idle", "permission");
    assert.strictEqual(s.ok, false);
  });
});
