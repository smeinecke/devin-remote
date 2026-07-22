import nodeCrypto from "node:crypto";

(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);

if (!(globalThis as any).crypto?.randomUUID) {
  (globalThis as any).crypto = nodeCrypto;
}
