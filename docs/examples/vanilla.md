# Vanilla example

Plain HTML/JS chat demo. The runnable file lives at `docs/examples/vanilla.html` in the repo — build first (`npm run build`), then serve the repo root and open it in a WebGPU-capable browser.

```html
<script type="module">
  import { BrowserAIEngine } from "../../dist/index.js";

  const engine = new BrowserAIEngine({ ui: { enabled: false } });

  if (!(await BrowserAIEngine.isWebGPUSupported())) {
    throw new Error("WebGPU not available in this browser");
  }

  await engine.loadModel("qwen-2.5-0.5b", (p) =>
    console.log(`loading… ${p.percent}% — ${p.mbPerSec} MB/s`),
  );

  const result = await engine.chat({
    messages: [{ role: "user", content: "Hello" }],
    onChunk: (d) => process.stdout.write(d),
  });
  console.log(result.text);

  // Mic → text, text → speech
  const text = await engine.transcribe(micBlob);
  await engine.speak(result.text);
</script>
```

See the full file: [`vanilla.html`](https://github.com/DezBenedek/browser-ai-engine/blob/main/docs/examples/vanilla.html).
