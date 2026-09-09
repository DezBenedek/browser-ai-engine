# Guide

## Install

```bash
npm install browser-ai-engine
```

React/Svelte peer deps are optional — install only the one you use.

## Prerequisites

Chat models need WebGPU (Chrome/Edge 113+, Safari with WebGPU, or Firefox with flags). Check at runtime:

```ts
import { BrowserAIEngine } from "browser-ai-engine";

if (!(await BrowserAIEngine.isWebGPUSupported())) {
  throw new Error("WebGPU is not available.");
}
```

## Quickstart

```ts
import { BrowserAIEngine } from "browser-ai-engine";

const ai = new BrowserAIEngine({
  ui: { enabled: true, position: "bottom-right", theme: "dark" },
});

await ai.loadModel("qwen-2.5-0.5b", (p) => console.log(`${p.percent}%`));

const result = await ai.chat({
  messages: [{ role: "user", content: "Summarize the README in one sentence." }],
  onChunk: (delta) => process.stdout.write(delta),
});
console.log(result.text);

const text = await ai.audio.transcribe(audioBlob);
console.log("Heard:", text);
```

## Tool calling

```ts
const result = await ai.chat({
  messages: [{ role: "user", content: "What is the weather in Budapest?" }],
  tools: [
    {
      name: "getWeather",
      description: "Get current weather.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
});
console.log(result.toolCalls);
```

## Next steps

- [API reference](./api-reference.md) — constructor options, chat, audio, tools.
- [Vanilla example](./examples/vanilla.html) — plain HTML/JS demo.
- [React example](./examples/react-example.tsx) / [Svelte example](./examples/svelte-example.svelte) — framework adapters.
