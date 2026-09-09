# browser-ai-engine

Client-side AI engine for the browser: chat models run on WebGPU via WebLLM, speech-to-text / text-to-speech run via Transformers.js. One download, then it works offline from Cache Storage. Framework-agnostic core with thin React and Svelte adapters, plus an optional floating widget.

## Requirements

Chat models need WebGPU:

- Chrome / Edge 113+
- Safari with WebGPU enabled
- Firefox with WebGPU flags (varies by version)

Check at runtime before loading a chat model:

```ts
const ok = await BrowserAIEngine.isWebGPUSupported();
if (!ok) throw new Error("WebGPU is not available in this browser.");
```

STT/TTS models (Whisper, SpeechT5) run on WASM/CPU and do not need WebGPU.

## Install

```bash
npm install browser-ai-engine
```

React / Svelte are optional peers — install only what you use:

```bash
npm install react    # only for browser-ai-engine/react
npm install svelte   # only for browser-ai-engine/svelte
```

## Quickstart

```ts
import { BrowserAIEngine } from "browser-ai-engine";

const ai = new BrowserAIEngine({
  ui: { enabled: true, position: "bottom-right", theme: "dark" },
});

await ai.loadModel("qwen-2.5-0.5b", (p) => {
  console.log(`${p.percent}% — ${p.mbPerSec} MB/s`);
});

const result = await ai.chat({
  messages: [{ role: "user", content: "Summarize the README in one sentence." }],
  onChunk: (delta) => process.stdout.write(delta),
});
console.log(result.text);
```

Tool calling (JSON-schema tools, native when the model supports it, prompt fallback otherwise):

```ts
const result = await ai.chat({
  messages: [{ role: "user", content: "What is the weather in Budapest?" }],
  tools: [
    {
      name: "getWeather",
      description: "Get current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  onChunk: (t) => console.log(t),
});
console.log(result.text, result.toolCalls);
```

Audio (Whisper STT, SpeechT5 TTS with native-speech fallback):

```ts
const text = await ai.audio.transcribe(audioBlob);
console.log("Heard:", text);

const wav = await ai.audio.synthesize("Model loaded. Ready.");
ai.audio.play(wav);
```

Disable the widget:

```ts
const ai = new BrowserAIEngine({ ui: { enabled: false } });
```

## Models

37 built-in models across 9 categories — chat (WebGPU), embedding, rerank,
sentiment, zero-shot classification, Q&A, summarization, translation (including
en↔hu), image classification, object detection, segmentation, OCR, STT and TTS.
Most are 15–300 MB and run on CPU via Transformers.js.

| ID | Task | Approx. download | Notes |
|---|---|---|---|
| `smollm2-135m` | chat | ~150 MB | Smallest chat model. Good for testing. |
| `smollm2-360m` | chat | ~300 MB | Better instruction following, still tiny. |
| `qwen-2.5-0.5b` | chat | ~400 MB | Default. Balanced small chat. |
| `embed-minilm-l6` | embedding | ~80 MB | Default embedder for RAG. |
| `rerank-minilm-l6` | rerank | ~90 MB | Re-ranks retrieval hits (~39 MRR@10). |
| `sentiment-distilbert` | classification | ~260 MB | English sentiment (~91% SST-2). |
| `zeroshot-mobilebert-mnli` | zero-shot | ~100 MB | Any labels, no training. |
| `translate-en-hu` / `translate-hu-en` | translation | ~300 MB | Offline EN↔HU. |
| `detect-yolos-tiny` | detection | ~30 MB | Realtime object detection. |
| `segment-segformer-b0` | segmentation | ~15 MB | Smallest vision model (37.4 mIoU). |
| `ocr-trocr-small` | ocr | ~250 MB | Printed text from images. |
| `whisper-tiny` | stt | ~150 MB | Multilingual STT on CPU. |

Full catalog with benchmarks: [docs/models.md](./docs/models.md).

```ts
import { listModels, listModelsByCategory, DEFAULT_MODEL } from "browser-ai-engine";

listModels("chat").map((m) => m.id);
listModelsByCategory("Vision").map((m) => `${m.id} — ${m.score ?? m.evals.join(", ")}`);
```

First `loadModel()` downloads weights from HuggingFace CDN and stores them in Cache Storage. Later loads work offline. STT/TTS weights load lazily on first `transcribe()` / `synthesize()`.

## React

```tsx
import { useBrowserAI } from "browser-ai-engine/react";

export function Chat() {
  const { ready, loading, progress, error, currentModel, loadModel, chat } =
    useBrowserAI();

  return (
    <div>
      <button onClick={() => loadModel("qwen-2.5-0.5b")}>Load</button>
      <button
        onClick={() =>
          chat([{ role: "user", content: "Hello" }]).then((t) => console.log(t))
        }
      >
        Send
      </button>
      <p>{loading ? `${progress?.percent ?? 0}%` : ready ? currentModel : error}</p>
    </div>
  );
}
```

## Svelte

```svelte
<script lang="ts">
  import { createBrowserAIStore } from "browser-ai-engine/svelte";
  const ai = createBrowserAIStore();
  let input = "";
  let reply = "";
  async function send() {
    reply = await ai.chat([{ role: "user", content: input }]);
  }
</script>

<button on:click={() => ai.loadModel("qwen-2.5-0.5b")}>Load</button>
<input bind:value={input} />
<button on:click={send}>Send</button>
<p>{reply}</p>
```

## More adapters

| Import | Framework | API |
|---|---|---|
| `browser-ai-engine/react` | React 18+ | `useBrowserAI()` hook |
| `browser-ai-engine/svelte` | Svelte 4+ | `createBrowserAIStore()` / `browserAIStore` |
| `browser-ai-engine/vue` | Vue 3+ | `useBrowserAI()` composable (refs) |
| `browser-ai-engine/solid` | SolidJS 1+ | `useBrowserAI()` (signals) |
| `browser-ai-engine/angular` | Angular 17+ | `BrowserAIService` (signals, `providedIn: root`) |
| `browser-ai-engine/store` | any / none | `createBrowserAI()` vanilla store (`subscribe`/`getSnapshot`) |
| `browser-ai-engine/webcomponent` | any / plain HTML | `<browser-ai-chat model="qwen-2.5-0.5b">` custom element |

```html
<script type="module">
  import { defineBrowserAIElements } from "browser-ai-engine/webcomponent";
  defineBrowserAIElements();
</script>
<browser-ai-chat model="smollm2-360m" theme="dark"></browser-ai-chat>
```

Framework peer deps are all optional — install only the one you use.

## Playground

Interactive test UI for every feature (models + download progress, streaming
chat with tools, pipelines, vision, audio, cache):

```bash
npm run build
npx serve .   # open http://localhost:3000/playground/
```

Live version (after each release): `https://dezbenedek.github.io/browser-ai-engine/playground/`

## Plain browser (no bundler)

The library lazy-loads `@mlc-ai/web-llm` and `@xenova/transformers` via bare
imports. Bundlers resolve those automatically; in a plain `<script type="module">`
page add an importmap (pinned versions matching this package):

```html
<script type="importmap">
  {
    "imports": {
      "@mlc-ai/web-llm": "https://esm.sh/@mlc-ai/web-llm@0.2.85",
      "@xenova/transformers": "https://esm.sh/@xenova/transformers@2.17.2"
    }
  }
</script>
```

Without an importmap the library falls back to the same CDN URLs automatically
— the importmap just makes it faster and version-explicit.

## Offline behavior

1. First `loadModel()` / `transcribe()` / `synthesize()` fetches weights over network.
2. Weights are stored in Cache Storage (chat) and IndexedDB (Transformers.js).
3. Later runs load from cache — the app works without network.

## API

Full reference: [docs/api-reference.md](./docs/api-reference.md).

Entry points: `BrowserAIEngine`, `MODEL_REGISTRY`, `listModels`, `listModelsByCategory`, `DEFAULT_MODEL`, `CacheManager`, `WorkerManager`, `TextModule`, `ToolModule`, `AudioModule`, `PipelineModule`, `FloatingWidget`, `useBrowserAI`, `createBrowserAIStore` / `browserAIStore`, `createBrowserAI` (vanilla store), `BrowserAIService` (Angular), `<browser-ai-chat>` (web component).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).

By Benedek Peter Dezso
