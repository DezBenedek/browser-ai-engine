# API reference

Concise reference for the public surface. Implementation lives in `src/`.

## `new BrowserAIEngine(options?)`

```ts
import { BrowserAIEngine } from "browser-ai-engine";

const ai = new BrowserAIEngine({
  autoEvict: true,
  modelDefaults: { temperature: 0.7, topP: 0.9, maxTokens: 1024 },
  cache: { enabled: true, scope: "browser-ai-engine-v1" },
  ui: { enabled: true, position: "bottom-right", theme: "dark" },
  worker: { enabled: false },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `autoEvict` | `boolean` | `true` | Unload the previous model when a new one loads. |
| `modelDefaults` | `{ temperature?, topP?, maxTokens? }` | `{}` | Per-call overrides win. |
| `cache.enabled` | `boolean` | `true` | Write prefetched weights to Cache Storage. |
| `cache.scope` | `string` | `"browser-ai-engine-v1"` | Cache Storage namespace. |
| `ui.enabled` | `boolean` | `false` | Mount the floating widget after load. |
| `ui.position` | `"bottom-right" \| "bottom-left" \| "top-right" \| "top-left"` | `"bottom-right"` | Widget corner (`top-*` maps to `bottom-right` in the current widget). |
| `ui.theme` | `"light" \| "dark" \| "auto"` | `"light"` | Widget theme (`auto` resolves to `light`). |
| `worker.enabled` | `boolean` | `false` | Run load/chat in `src/worker/inference.worker.ts`. |

Events: `ai.on("model-loading" | "model-ready" | "model-error" | "progress" | "memory", cb)` returns an unsubscribe function.

## `loadModel(modelId, onProgress?)`

Downloads (first run) and activates a model. Must be called before `chat()`.

```ts
await ai.loadModel("qwen-2.5-0.5b", (p) => {
  console.log(p.percent, p.mbPerSec, p.etaSec, p.status);
});
// p: LoadProgress { modelId, loadedBytes, totalBytes, percent, mbPerSec, etaSec, status }
```

- Unknown IDs throw with the list of known IDs.
- Chat models require WebGPU (`BrowserAIEngine.isWebGPUSupported()`).
- `transformers` models (`stt`/`tts`/`embedding`) only prefetch here; weights load lazily in `AudioModule`.

## `chat(options)`

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
  tool_choice: "auto",
  responseFormat: { type: "json_object" },
  temperature: 0.2,
  maxTokens: 512,
  topP: 0.9,
  signal: abortController.signal,
  onChunk: (delta) => el.textContent += delta,
});

console.log(result.text);       // full reply
console.log(result.toolCalls);  // [{ name, arguments, id? }]
console.log(result.usage);      // { promptTokens?, completionTokens? }
```

## `streamChat(options)`

Same options as `chat()`. Yields deltas, returns the final `ChatResult`:

```ts
for await (const delta of ai.streamChat({ messages })) {
  el.textContent += delta;
}
```

## Audio

```ts
// Speech-to-text (Whisper, lazy load)
const text: string = await ai.audio.transcribe(blob, {
  model: "whisper-tiny",
  language: "en",
});

// Text-to-speech (SpeechT5, native-speech fallback)
const wav: Blob = await ai.audio.synthesize("Done.", { voice: customUrl });
const el = ai.audio.play(wav);
ai.audio.stopAll();

// Shortcuts on the engine
await ai.transcribe(blob);
await ai.speak("Done.");

// Capability check (never throws)
ai.audio.isSupported(); // { stt: boolean, tts: boolean }
```

## Tools

`ToolModule` parses `{"name","arguments"}` JSON out of free text when the model has no native tool support, validates args against a minimal JSON-schema subset, and dispatches to handlers:

```ts
import { ToolModule } from "browser-ai-engine";

const calls = ToolModule.extractToolCalls(text, tools);
const check = ToolModule.validateArgs(schema, args); // { ok, errors? }
const results = await ToolModule.dispatch(calls, { getWeather: async (a) => ({}) });
```

## Models

```ts
import { MODEL_REGISTRY, MODEL_CATEGORIES, listModels, listModelsByCategory, DEFAULT_MODEL } from "browser-ai-engine";

listModels();        // all (37 models)
listModels("translation");  // chat | stt | tts | embedding | rerank | text-classification | ...
listModelsByCategory("Vision"); // Chat | Embedding & retrieval | Classification | ...
```

## Cache

```ts
await ai.cache.has("qwen-2.5-0.5b");
await ai.cache.keys();
await ai.cache.usage();          // { entries, approxBytes }
await ai.clearCache("qwen-2.5-0.5b");
await ai.cache.clearAll();
await ai.cache.tryOpfsPersist(); // request persistent storage
```

## Lifecycle

```ts
ai.listModels("chat");
ai.getMemory(); // { currentModel, heapMB?, gpu }
await ai.unload();
await ai.dispose(); // worker + widget + model cleanup
BrowserAIEngine.isWebGPUSupported(); // Promise<boolean>
```

## Widget

```ts
import { FloatingWidget } from "browser-ai-engine";

const widget = new FloatingWidget({
  position: "bottom-right",
  theme: "dark",
  onLoadModel: (id) => ai.loadModel(id),
  onClearCache: (id) => ai.clearCache(id),
  getModels: () => ai.listModels().map((m) => ({ id: m.id, sizeMb: m.sizeMB })),
  getMemory: async () => ({ note: "…" }),
});
widget.mount();
widget.setProgress({ percent: 42, mbPerSec: 8.5, etaSec: 30 });
widget.setGpuStatus(true);
widget.setModels([{ id: "qwen-2.5-0.5b", cached: true }]);
widget.destroy();
```

Full theme lives in `src/ui/widget.css` (copied to `dist/widget.css` on build). Override at runtime with `widget.setCustomCss(css)` or import the file:

```ts
import "browser-ai-engine/widget.css";
```

## Adapters

React (`browser-ai-engine/react`):

```ts
import { useBrowserAI } from "browser-ai-engine/react";

const { ready, loading, progress, error, currentModel, loadModel, chat, unload } =
  useBrowserAI({ modelId: "qwen-2.5-0.5b", autoLoad: false });
// chat(messages, { temperature?, maxTokens?, signal?, onToken? }) => Promise<string>
```

Svelte (`browser-ai-engine/svelte`):

```ts
import { createBrowserAIStore, browserAIStore } from "browser-ai-engine/svelte";

const ai = createBrowserAIStore({ modelId: "qwen-2.5-0.5b" });
// ai.loadModel(id), ai.chat(messages, opts) => Promise<string>, ai.unload(), ai.dispose()
// stores: ai.ready, ai.loading, ai.progress, ai.error, ai.currentModel
```

Vue (`browser-ai-engine/vue`):

```ts
import { useBrowserAI } from "browser-ai-engine/vue";

const { ready, loading, progress, error, currentModel, loadModel, chat, unload } =
  useBrowserAI({ autoLoad: false });
// same chat() signature; state is Vue refs
```

Solid (`browser-ai-engine/solid`):

```ts
import { useBrowserAI } from "browser-ai-engine/solid";

const { ready, loading, loadModel, chat } = useBrowserAI();
// same chat() signature; state is Solid accessors
```

Angular (`browser-ai-engine/angular`):

```ts
import { BrowserAIService } from "browser-ai-engine/angular";

constructor(private ai: BrowserAIService) {}
// this.ai.ready() signal, await this.ai.loadModel(id),
// await this.ai.chat(messages, opts), await this.ai.destroy()
```

Vanilla store (`browser-ai-engine/store`, no framework):

```ts
import { createBrowserAI } from "browser-ai-engine/store";

const ai = createBrowserAI();
const unsub = ai.subscribe((s) => console.log(s.loading));
await ai.loadModel("qwen-2.5-0.5b");
// useSyncExternalStore-compatible: ai.subscribe + ai.getSnapshot
```

Web component (`browser-ai-engine/webcomponent`, plain HTML):

```html
<script type="module">
  import { defineBrowserAIElements } from "browser-ai-engine/webcomponent";
  defineBrowserAIElements();
</script>
<browser-ai-chat model="qwen-2.5-0.5b" theme="dark"></browser-ai-chat>
```

## Dependency loading (browser without bundler)

`@mlc-ai/web-llm` and `@xenova/transformers` load lazily via bare imports
(bundlers resolve them). In a plain page add an importmap; otherwise the
library falls back to pinned esm.sh builds (`WEBLLM_CDN_URL`,
`TRANSFORMERS_CDN_URL` — re-exported for inspection).

```ts
import { listModelsByCategory } from "browser-ai-engine";

await ai.listModelsDetailed("chat"); // ModelInfo[] + cached flag per model
await ai.isModelCached(getModel("whisper-tiny")!); // checks all browser caches
```
