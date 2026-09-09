---
layout: home

hero:
  name: browser-ai-engine
  text: Browser-native AI, offline-first.
  tagline: Local LLM chat, speech-to-text and text-to-speech. WebGPU inference, no server needed after first load.
  actions:
    - theme: brand
      text: Guide
      link: /guide
    - theme: alt
      text: API reference
      link: /api-reference
    - theme: alt
      text: Examples
      link: /examples/vanilla

features:
  - title: Local LLM chat
    details: WebLLM on WebGPU, streaming responses, runs in a Web Worker.
  - title: Speech in and out
    details: Whisper-based transcription and TTS via Transformers.js.
  - title: Tool calling with Zod
    details: Schemas validated before dispatch, errors fed back to the model.
  - title: Offline after first load
    details: Weights cached in the browser. Preload while online, use offline.
---
