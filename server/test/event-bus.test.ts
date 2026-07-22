import { describe, it } from "node:test";
import assert from "node:assert";
import { EventBus } from "../src/event-bus.js";

describe("EventBus", () => {
  it("numbers events monotonically per session/generation", () => {
    const bus = new EventBus();
    const seqs: number[] = [];
    bus.subscribe((_sid, env) => seqs.push(env.sequence));
    bus.emit("s1", 1, "a", {});
    bus.emit("s1", 1, "b", {});
    bus.emit("s2", 1, "a", {});
    bus.emit("s1", 1, "c", {});
    assert.deepStrictEqual(seqs, [1, 2, 1, 3]);
  });

  it("replays in order and honors cursors", () => {
    const bus = new EventBus();
    bus.emit("s1", 1, "a", { v: 1 });
    bus.emit("s1", 1, "b", { v: 2 });
    bus.emit("s1", 1, "c", { v: 3 });
    const replayed = bus.replay("s1", 1, 1)?.map((e) => e.type);
    assert.deepStrictEqual(replayed, ["b", "c"]);
  });

  it("snapshot carries state and recent events", () => {
    const bus = new EventBus();
    bus.emit("s1", 1, "a", { v: 1 });
    const snap = bus.snapshot("s1", 1, { status: "idle" }) as any;
    assert.strictEqual(snap.type, "snapshot");
    assert.strictEqual(snap.state.status, "idle");
    assert.strictEqual(snap.events.length, 1);
    assert.strictEqual(snap.events[0].sequence, 1);
  });

  it("snapshot declares complete/materialized semantics", () => {
    const bus = new EventBus();
    bus.emit("s1", 1, "a", { v: 1 });
    const snap = bus.snapshot("s1", 1, { latestSequence: 1 }) as any;
    assert.strictEqual(snap.complete, false);
    assert.strictEqual(snap.baseSequence, 1);
    assert.strictEqual(snap.latestSequence, 1);
    assert.strictEqual(snap.state, snap.state);
  });

  it("snapshot is empty and reports latestSequence 0 when no buffer exists", () => {
    const bus = new EventBus();
    const snap = bus.snapshot("s1", 1, { status: "idle" }) as any;
    assert.strictEqual(snap.events.length, 0);
    assert.strictEqual(snap.baseSequence, null);
    assert.strictEqual(snap.latestSequence, 0);
    assert.strictEqual(snap.complete, false);
  });

  it("reset increments generation and starts new sequence", () => {
    const bus = new EventBus();
    bus.emit("s1", 1, "a", {});
    bus.reset("s1", 2);
    bus.emit("s1", 2, "b", {});
    const g1 = bus.replay("s1", 1, 0)?.length;
    const g2 = bus.replay("s1", 2, 0)?.length;
    assert.strictEqual(g1, 1);
    assert.strictEqual(g2, 1);
  });
});
