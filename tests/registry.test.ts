import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  MODEL_CATEGORIES,
  MODEL_LIST,
  MODEL_REGISTRY,
  getModel,
  isKnownModel,
  listModels,
  listModelsByCategory,
} from "../src/core/registry.js";
import { PipelineModule } from "../src/modules/PipelineModule.js";

/** Chat modellek, amik tudottan 300 MB felett vannak (minőségi nagy modellek). */
const LEGACY_LARGE_CHAT = new Set([
  "qwen-2.5-0.5b",
  "qwen-2.5-1.5b",
  "qwen-2.5-3b",
  "llama-3.2-1b",
  "llama-3.2-3b",
  "phi-3.5-mini",
  "gemma-2-2b",
  "deepseek-r1-distill-qwen-1.5b",
]);

/** Placeholder modellek, amikhez még nincs súly (nincs hfRepo). */
const PLACEHOLDER_NO_REPO = new Set(["tts-kokoro"]);

describe("registry integrity", () => {
  it("default model exists and is chat", () => {
    expect(isKnownModel(DEFAULT_MODEL)).toBe(true);
    expect(getModel(DEFAULT_MODEL)?.task).toBe("chat");
  });

  it("ids are unique and match keys", () => {
    const ids = MODEL_LIST.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODEL_LIST) {
      expect(MODEL_REGISTRY[m.id]).toBe(m);
    }
  });

  it("providers have resolvable locations", () => {
    for (const m of MODEL_LIST) {
      if (m.provider === "webllm") {
        expect(m.modelUrl, `${m.id} modelUrl`).toMatch(/^https:\/\//);
      } else if (PLACEHOLDER_NO_REPO.has(m.id)) {
        expect(m.hfRepo, `${m.id} placeholder`).toBeUndefined();
      } else {
        expect(m.hfRepo, `${m.id} hfRepo`).toMatch(/^[\w-]+\/[\w.-]+$/);
      }
    }
  });

  it("new small models stay within the 300MB budget", () => {
    for (const m of MODEL_LIST) {
      if (LEGACY_LARGE_CHAT.has(m.id)) continue;
      expect(m.sizeMB, `${m.id} sizeMB`).toBeGreaterThan(0);
      expect(m.sizeMB, `${m.id} sizeMB`).toBeLessThanOrEqual(300);
    }
  });

  it("every model has category, description and evals", () => {
    for (const m of MODEL_LIST) {
      expect(MODEL_CATEGORIES, m.id).toContain(m.category);
      expect(m.description.length, m.id).toBeGreaterThan(10);
      expect(Array.isArray(m.evals), m.id).toBe(true);
    }
  });

  it("categories and tasks filter consistently", () => {
    for (const c of MODEL_CATEGORIES) {
      for (const m of listModelsByCategory(c)) {
        expect(m.category).toBe(c);
      }
    }
    const chat = listModels("chat");
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((m) => m.task === "chat")).toBe(true);
    const total = MODEL_CATEGORIES.reduce((n, c) => n + listModelsByCategory(c).length, 0);
    expect(total).toBe(MODEL_LIST.length);
  });
});

describe("PipelineModule", () => {
  it("maps every non-chat task to a pipeline", () => {
    const tasks = new Set(MODEL_LIST.map((m) => m.task));
    expect(tasks.has("chat")).toBe(true);
    for (const t of tasks) {
      if (t === "chat") continue;
      expect(() => PipelineModule.pipelineFor(t)).not.toThrow();
      expect(typeof PipelineModule.pipelineFor(t)).toBe("string");
    }
  });

  it("rejects chat models and unknown ids without loading anything", async () => {
    const pipes = new PipelineModule();
    await expect(pipes.run("qwen-2.5-0.5b", "hi")).rejects.toThrow(/chat/i);
    await expect(pipes.run("nope-not-a-model", "hi")).rejects.toThrow(/ismeretlen/);
  });
});
