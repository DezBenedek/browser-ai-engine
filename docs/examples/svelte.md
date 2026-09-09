# Svelte example

Minimal chat UI with `createBrowserAIStore`. Full file: `docs/examples/svelte-example.svelte` in the repo.

```svelte
<script lang="ts">
  import { createBrowserAIStore } from "browser-ai-engine/svelte";

  const ai = createBrowserAIStore();

  let input = "";
  let reply = "";

  async function load() {
    await ai.loadModel("qwen-2.5-0.5b");
  }

  async function send() {
    if (!input.trim()) return;
    const q = input.trim();
    input = "";
    reply = await ai.chat([{ role: "user", content: q }]);
  }
</script>

<div style="max-width: 640px;">
  <p>Status: {$ai.loading ? `Loading… ${$ai.progress?.percent ?? 0}%` : $ai.ready ? "Ready" : ($ai.error ?? "Idle")}</p>
  <div style="display: flex; gap: 8px;">
    <button on:click={load}>Load</button>
    <input bind:value={input} placeholder="Ask something…" style="flex: 1;" />
    <button on:click={send}>Send</button>
    <button on:click={() => ai.unload()}>Unload</button>
  </div>
  <p style="white-space: pre-wrap;">{reply}</p>
</div>
```
