import { describe, expect, it } from "vitest";
import { extractJson, extractToolCalls, validateArgs } from "../src/modules/ToolModule.js";
import { buildToolInstruction, estimateTokens } from "../src/modules/TextModule.js";
import { getModel, listModels, isKnownModel, DEFAULT_MODEL } from "../src/core/registry.js";

const tools = [
  {
    name: "getWeather",
    description: "Get current weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

describe("registry", () => {
  it("default model is known", () => {
    expect(isKnownModel(DEFAULT_MODEL)).toBe(true);
    expect(getModel(DEFAULT_MODEL)?.task).toBe("chat");
    expect(listModels("chat").length).toBeGreaterThan(0);
    expect(listModels("stt").length).toBeGreaterThan(0);
  });
});

describe("ToolModule", () => {
  it("extracts fenced json tool call", () => {
    const text = '```json\n{"name": "getWeather", "arguments": {"city": "Budapest"}}\n```';
    expect(extractJson(text)).toEqual({
      name: "getWeather",
      arguments: { city: "Budapest" },
    });
    expect(extractToolCalls(text, tools)).toEqual([
      { name: "getWeather", arguments: { city: "Budapest" } },
    ]);
  });

  it("validates required fields", () => {
    expect(validateArgs(tools[0]!.parameters as never, { city: "x" }).ok).toBe(true);
    const bad = validateArgs(tools[0]!.parameters as never, {});
    expect(bad.ok).toBe(false);
    expect(bad.errors?.join(" ")).toContain("city");
  });
});

describe("TextModule helpers", () => {
  it("builds instruction and estimates tokens", () => {
    expect(buildToolInstruction(tools)).toContain("getWeather");
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(0);
  });
});
