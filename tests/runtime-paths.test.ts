import { describe, expect, it } from "vitest";
import { normalizeWorkerProgress } from "../src/core/WorkerManager.js";
import { matchesRepoPath, toWebLLMTools } from "../src/core/Engine.js";
import { isWhisperModelId, resolveWhisperRepo } from "../src/modules/AudioModule.js";
import { workerToolName } from "../src/worker/inference.worker.js";

describe("matchesRepoPath", () => {
  const tinyUrl = "https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json";
  const tinyEnUrl = "https://huggingface.co/Xenova/whisper-tiny.en/resolve/main/config.json";

  it("matches the exact repo path", () => {
    expect(matchesRepoPath(tinyUrl, "Xenova/whisper-tiny")).toBe(true);
  });

  it("rejects dot-extended sibling repos (whisper-tiny vs whisper-tiny.en)", () => {
    expect(matchesRepoPath(tinyEnUrl, "Xenova/whisper-tiny")).toBe(false);
    expect(matchesRepoPath(tinyUrl, "Xenova/whisper-tiny.en")).toBe(false);
    expect(matchesRepoPath(tinyEnUrl, "Xenova/whisper-tiny.en")).toBe(true);
  });

  it("matches WebLLM model urls and rejects unrelated hosts", () => {
    const url =
      "https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/ndarray-cache.json";
    expect(matchesRepoPath(url, "mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC")).toBe(true);
    expect(matchesRepoPath(url, "mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC")).toBe(false);
    expect(matchesRepoPath("https://example.com/other", "Xenova/whisper-tiny")).toBe(false);
    expect(matchesRepoPath(tinyUrl, "")).toBe(false);
  });
});

describe("normalizeWorkerProgress edges", () => {
  it("drops non-finite percentages", () => {
    expect(normalizeWorkerProgress({ percent: NaN }, "m", 100)).toBeNull();
    expect(normalizeWorkerProgress({ percent: Infinity }, "m", 100)).toBeNull();
    expect(normalizeWorkerProgress({ progress: NaN }, "m", 100)).toBeNull();
  });

  it("clamps out-of-range percentages to 0..100", () => {
    expect(normalizeWorkerProgress({ percent: 150 }, "m", 100)?.percent).toBe(100);
    expect(normalizeWorkerProgress({ percent: -20 }, "m", 100)?.percent).toBe(0);
    expect(normalizeWorkerProgress({ progress: 2 }, "m", 100)?.percent).toBe(100);
    expect(normalizeWorkerProgress({ progress: -1 }, "m", 100)?.percent).toBe(0);
  });

  it("sanitizes bytes and status", () => {
    const p = normalizeWorkerProgress(
      { percent: 10, loadedBytes: -5, totalBytes: NaN, status: "bogus" },
      "m",
      100,
    );
    expect(p).toMatchObject({ loadedBytes: 0, totalBytes: 0, status: "downloading" });
  });
});

describe("whisper model resolution", () => {
  it("resolves known ids and defaults to whisper-tiny", () => {
    expect(resolveWhisperRepo()).toBe("Xenova/whisper-tiny");
    expect(resolveWhisperRepo("whisper-base")).toBe("Xenova/whisper-base");
    expect(resolveWhisperRepo("whisper-tiny-en")).toBe("Xenova/whisper-tiny.en");
  });

  it("rejects unknown ids with the valid list", () => {
    expect(() => resolveWhisperRepo("whisper-large")).toThrow(/ismeretlen Whisper-modell/);
  });

  it("guards whisper ids", () => {
    expect(isWhisperModelId("whisper-tiny-en")).toBe(true);
    expect(isWhisperModelId("whisper-large")).toBe(false);
  });
});

describe("worker tool interop", () => {
  it("maps ToolDefinitions to the OpenAI shape the worker expects", () => {
    expect(
      toWebLLMTools([
        { name: "getWeather", description: "d", parameters: { type: "object" } },
      ]),
    ).toEqual([
      {
        type: "function",
        function: { name: "getWeather", description: "d", parameters: { type: "object" } },
      },
    ]);
    expect(toWebLLMTools([])).toEqual([]);
  });

  it("reads tool names from both OpenAI and raw shapes", () => {
    expect(workerToolName({ type: "function", function: { name: "a" } })).toBe("a");
    expect(workerToolName({ name: "b", description: "x", parameters: {} })).toBe("b");
    expect(workerToolName({})).toBeNull();
    expect(workerToolName(null)).toBeNull();
    expect(workerToolName("a")).toBeNull();
  });
});
