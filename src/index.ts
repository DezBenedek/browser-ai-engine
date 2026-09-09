// src/index.ts
// Nyilvános belépési pont. Kanonikus modulhelyek:
//   core/Engine.ts       -> BrowserAIEngine
//   core/CacheManager.ts -> CacheManager
//   core/WorkerManager.ts-> WorkerManager
//   core/registry.ts     -> MODEL_REGISTRY, listModels, DEFAULT_MODEL
//   core/types.ts        -> megosztott típusok
//   modules/text.ts      -> TextModule
//   modules/tools.ts     -> ToolModule
//   modules/audio.ts     -> AudioModule
//   ui/Widget.ts         -> FloatingWidget
// Ha egy exportált modul még nem létezik, a hiba forrása a fenti leképezés.

export { BrowserAIEngine } from "./core/Engine.js";
export type { ModelWithCache } from "./core/Engine.js";
export { CacheManager } from "./core/CacheManager.js";
export { WorkerManager, WORKER_DISABLED } from "./core/WorkerManager.js";
export {
  normalizeWorkerProgress,
  normalizeWorkerToken,
  normalizeWorkerChatResult,
} from "./core/WorkerManager.js";
export {
  importWebLLM,
  importTransformers,
  WEBLLM_VERSION,
  TRANSFORMERS_VERSION,
  WEBLLM_CDN_URL,
  TRANSFORMERS_CDN_URL,
} from "./core/loader.js";
export { MODEL_REGISTRY, MODEL_CATEGORIES, listModels, listModelsByCategory, DEFAULT_MODEL } from "./core/registry.js";

export { TextModule } from "./modules/TextModule.js";
export { ToolModule } from "./modules/ToolModule.js";
export { AudioModule } from "./modules/AudioModule.js";
export { PipelineModule } from "./modules/PipelineModule.js";

export { FloatingWidget, DEFAULT_CSS, WIDGET_CSS } from "./ui/Widget.js";
export type {
  WidgetOptions,
  WidgetPosition,
  WidgetTheme,
  WidgetProgress,
  WidgetModelEntry,
  WidgetMemoryInfo,
} from "./ui/Widget.js";

export type * from "./core/types.js";

export type {
  WorkerRequest,
  WorkerResponse,
  WorkerRequestType,
  WorkerResponseType,
  LoadPayload,
  ChatPayload,
  ProgressChunk,
  TokenChunk,
  DoneData,
  StatusData,
} from "./worker/inference.worker.js";
export type { ChatMessage as WorkerChatMessage } from "./worker/inference.worker.js";
