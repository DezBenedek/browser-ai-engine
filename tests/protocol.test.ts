import { describe, expect, it } from "vitest";
import {
  normalizeWorkerChatResult,
  normalizeWorkerProgress,
  normalizeWorkerToken,
} from "../src/core/WorkerManager.js";
import { createBrowserAI } from "../src/adapters/store.js";

describe("worker protocol normalization", () => {
  it("accepts LoadProgress-shaped chunks", () => {
    const p = normalizeWorkerProgress({ percent: 42, mbPerSec: 8 }, "m", 100);
    expect(p).toMatchObject({ modelId: "m", percent: 42, mbPerSec: 8 });
  });

  it("accepts {progress 0..1} chunks and estimates bytes", () => {
    const p = normalizeWorkerProgress({ kind: "progress", progress: 0.5, text: "x" }, "m", 100);
    expect(p).toMatchObject({ modelId: "m", percent: 50, totalBytes: 100 * 1024 * 1024 });
  });

  it("drops unknown progress shapes", () => {
    expect(normalizeWorkerProgress(null, "m", 100)).toBeNull();
    expect(normalizeWorkerProgress({ kind: "token", delta: "hi" }, "m", 100)).toBeNull();
  });

  it("extracts token deltas", () => {
    expect(normalizeWorkerToken("hi")).toBe("hi");
    expect(normalizeWorkerToken({ kind: "token", delta: "hi" })).toBe("hi");
    expect(normalizeWorkerToken(42)).toBe("");
  });

  it("normalizes DoneData to ChatResult", () => {
    const r = normalizeWorkerChatResult(
      { kind: "done", text: "hello", modelId: "m" },
      "m",
    );
    expect(r).toMatchObject({ text: "hello", toolCalls: [], modelId: "m" });
  });

  it("passes through full ChatResult shapes", () => {
    const r = normalizeWorkerChatResult(
      { text: "hi", toolCalls: [{ name: "t", arguments: {} }], modelId: "m" },
      "fallback",
    );
    expect(r?.toolCalls).toHaveLength(1);
    expect(r?.modelId).toBe("m");
  });

  it("rejects result garbage", () => {
    expect(normalizeWorkerChatResult({ nope: 1 }, "m")).toBeNull();
  });
});

describe("vanilla store", () => {
  it("starts idle and notifies subscribers", () => {
    const store = createBrowserAI();
    expect(store.getState()).toMatchObject({ ready: false, loading: false, error: null });
    const seen: boolean[] = [];
    const unsub = store.subscribe((s) => seen.push(s.loading));
    void store.loadModel("qwen-2.5-0.5b").catch(() => undefined);
    expect(seen).toContain(true);
    unsub();
  });

  it("reports client-only error outside the browser", async () => {
    const store = createBrowserAI();
    await expect(store.loadModel("qwen-2.5-0.5b")).rejects.toThrow(/kliens/);
    expect(store.getState().error).toMatch(/kliens/);
  });
});
