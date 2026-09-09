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

| ID | Task | Approx. download | Notes |
|---|---|---|---|
| `qwen-2.5-0.5b` | chat | ~400 MB | Default. Smallest, good for testing. |
| `qwen-2.5-1.5b` | chat | ~1100 MB | Balanced quality/size. |
| `qwen-2.5-3b` | chat | ~2200 MB | Stronger reasoning, needs 4 GB+ VRAM. |
| `llama-3.2-1b` | chat | ~900 MB | Short instruction following. |
| `llama-3.2-3b` | chat | ~2400 MB | Summarization, RAG. |
| `phi-3.5-mini` | chat | ~2700 MB | Code and reasoning. |
| `gemma-2-2b` | chat | ~1800 MB | Strict instruction following. |
| `deepseek-r1-distill-qwen-1.5b` | chat | ~1200 MB | Step-by-step reasoning traces. |
| `whisper-tiny` | stt | ~150 MB | Realtime STT on CPU. |
| `whisper-base` | stt | ~250 MB | More accurate STT. |
| `speecht5` | tts | ~320 MB | CPU speech synthesis. |
| `snowflake-arctic-embed-xs` | embedding | ~180 MB | RAG / semantic search. |

```ts
import { listModels, DEFAULT_MODEL } from "browser-ai-engine";

listModels("chat").map((m) => m.id);
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

## Offline behavior

1. First `loadModel()` / `transcribe()` / `synthesize()` fetches weights over network.
2. Weights are stored in Cache Storage (chat) and IndexedDB (Transformers.js).
3. Later runs load from cache — the app works without network.

## API

Full reference: [docs/api-reference.md](./docs/api-reference.md).

Entry points: `BrowserAIEngine`, `MODEL_REGISTRY`, `listModels`, `DEFAULT_MODEL`, `CacheManager`, `WorkerManager`, `TextModule`, `ToolModule`, `AudioModule`, `FloatingWidget`, `useBrowserAI`, `createBrowserAIStore` / `browserAIStore`.

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
