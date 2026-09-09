# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.0] - 2026-09-09

### Added
- Model catalog expanded from 13 to 37 models in 9 categories (Chat, Embedding
  & retrieval, Classification, Comprehension, Generation, Translation, Vision,
  Document, Speech); most models are 15–300 MB and run on CPU.
- New `docs/models.md` catalog page with per-category benchmark tables.
- New adapters: Vue 3 (`browser-ai-engine/vue`), SolidJS (`browser-ai-engine/solid`),
  Angular 17+ (`browser-ai-engine/angular`), framework-agnostic vanilla store
  (`browser-ai-engine/store`), Web Component (`browser-ai-engine/webcomponent`).
- New `PipelineModule` for running any non-chat task (classify, QA, summarize,
  translate, embed, rerank, detect, segment, OCR) plus `warmup()` preloading.
- New `playground/` interactive test UI covering every feature (models, chat +
  tools, pipelines, vision, audio, cache).
- New `release.sh` one-command release pipeline (checks → changelog → tag →
  push → npm publish → GitHub release).
- `listModelsDetailed()` / `isModelCached()` — cache status across WebLLM,
  transformers.js and internal Cache Storage; widget shows cached badges.
- `src/core/loader.ts` — bare-import with pinned esm.sh CDN fallback, so the
  library works in plain `<script type="module">` pages without a bundler.
- `whisper-tiny-en` STT model; `chat`/`loadModel` also work through the worker
  with tool-call parity and normalized progress/token/result shapes.

### Fixed
- `loadModel()` for transformers models actually downloads weights now
  (previously it only reported ready).
- Worker chat no longer yields `[object Object]` tokens and no longer drops
  `toolCalls`; worker progress events are normalized to `LoadProgress`.
- `qwen-2.5-0.5b` registry URL corrected to the real Qwen2.5 MLC weights.
- Removed `snowflake-arctic-embed-xs` (gated Hub repo, not loadable without a token).
- Docs build dead links fixed; worker bundle is self-contained again (5.8 MB IIFE).

## [0.1.0] - 2026-09-09

Initial public release.

### Added
- `BrowserAIEngine`: WebLLM chat (streaming, tool calling, JSON fallback),
  Whisper STT / SpeechT5 TTS audio module, persistent cache, Web Worker support.
- Floating widget UI (Shadow DOM, dark/light, progress, model list, memory).
- React (`useBrowserAI`) and Svelte (`browserAIStore`) adapters.
- 13-model registry (Qwen, Llama, Phi, Gemma, DeepSeek, Whisper, SpeechT5).
- VitePress docs with GitHub Pages deployment and CI workflow.
