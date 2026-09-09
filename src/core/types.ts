/**
 * Közös típusok a browser-ai-engine core rétegéhez.
 *
 * Irányelvek:
 * - Minden modul ezt a fájlt használja; körkörös import tilos.
 * - Relatív import ESM-kompatibilisen: `./types.js` formában.
 * - `strict` TS mellett fordul; `exactOptionalPropertyTypes` barát
 *   (opcionális mezők explicit `| undefined` nélkül, de mindig guardolva).
 */

/** Chat üzenet szerepkörök (OpenAI-kompatibilis). */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Egy chat üzenet. `tool` szerepnél `tool_call_id` köti össze a hívással. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

/** Tool (függvényhívás) definíció JSON Schema paraméterekkel. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object a paraméterekre. */
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/** Toolválasztási stratégia chat híváshoz. */
export type ToolChoiceOption = 'auto' | 'none' | { name: string };

/** Egy chat kérés összes paramétere. */
export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoiceOption;
  /** Streaming részletek (már összefűzött delta szöveg). */
  onChunk?: (deltaText: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: { type: 'json_object' };
}

/** Egy eszközhívás a modell válaszából. */
export interface ChatToolCall {
  name: string;
  arguments: unknown;
  id?: string;
}

/** Chat hívás végeredménye. */
export interface ChatResult {
  text: string;
  toolCalls: ChatToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  modelId: string;
}

/** Modellszolgáltató: WebLLM (WebGPU) vagy transformers.js (WASM/CPU). */
export type ModelProvider = 'webllm' | 'transformers';

/** Modell feladat: chat, hang, kép, szöveges pipeline-ok. */
export type ModelTask =
  | 'chat'
  | 'stt'
  | 'tts'
  | 'embedding'
  | 'rerank'
  | 'text-classification'
  | 'zero-shot'
  | 'qa'
  | 'summarization'
  | 'text2text'
  | 'translation'
  | 'image-classification'
  | 'object-detection'
  | 'segmentation'
  | 'ocr';

/** Kategória a katalógus csoportosításához (docs/models oldal). */
export type ModelCategory =
  | 'Chat'
  | 'Embedding & retrieval'
  | 'Classification'
  | 'Comprehension'
  | 'Generation'
  | 'Translation'
  | 'Vision'
  | 'Document'
  | 'Speech';

/** Egy regisztrált modell metaadatai. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
  /** WebLLM `model_list` URL (pl. HuggingFace `.../resolve/main/`). */
  modelUrl?: string;
  /** Transformers.js modell (pl. `Xenova/whisper-tiny`). */
  hfRepo?: string;
  /** Letöltési méret megabájtban (közelítő). */
  sizeMB: number;
  /** Paraméterszám kijelzéshez (pl. `0.5B`, `39M`). */
  params: string;
  /** Kontextusablak tokenben. Nem szöveges modellnél 0. */
  contextWindow: number;
  /** Kvantálás (pl. `q4f16_1`). */
  quantization?: string;
  task: ModelTask;
  /** Kategória a katalógus csoportosításához. */
  category: ModelCategory;
  /** Becsült VRAM-igény megabájtban (futási overheadtel). */
  vramMB: number;
  description: string;
  /**
   * Szabványos kiértékelő adathalmazok, amiken a modellt mérik
   * (pl. `MMLU`, `SQuAD v1.1`, `COCO`, `LibriSpeech`). Rangsoroláshoz.
   */
  evals: string[];
  /**
   * Kiemelt mért eredmény, ha közismert (pl. `76.1% top-1`).
   * Tájékoztató adat a modellkártya/paper alapján, nem saját mérés.
   */
  score?: string;
}

/** Alapértelmezett generálási paraméterek. */
export interface ModelDefaults {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** Cache viselkedés. `enabled: false` esetén nincs Cache API írás. */
export interface CacheOptions {
  enabled: boolean;
  scope?: string;
}

/** Lebegő UI widget kapcsolók. */
export interface UiOptions {
  enabled: boolean;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  theme?: 'light' | 'dark' | 'auto';
}

/** Worker kapcsolók. `enabled: false` = főszálas futás. */
export interface WorkerOptions {
  enabled: boolean;
  /**
   * Egyedi worker script URL (pl. saját bundler kimenet).
   * Ha nincs megadva, az Engine a `dist/inference.worker.global.js`
   * melletti alapértelmezett helyet próbálja `import.meta.url`-ből.
   */
  url?: string | URL;
}

/** Motor konfiguráció a konstruktorhoz. Minden mező opcionális. */
export interface EngineOptions {
  modelDefaults?: ModelDefaults;
  cache?: CacheOptions;
  ui?: UiOptions;
  worker?: WorkerOptions;
  /** Új modell töltésekor az előző automatikus kipakolása. Alapértelmezett: true. */
  autoEvict?: boolean;
}

/** Modellbetöltési folyamatjelzés. */
export interface LoadProgress {
  modelId: string;
  loadedBytes: number;
  /** 0 = ismeretlen (nincs Content-Length). */
  totalBytes: number;
  /** 0–100. Ismeretlen végösszegnél az utolsó ismert arány vagy 0. */
  percent: number;
  /** MB/s; 0 = nem számítható. */
  mbPerSec: number;
  /** Hátralévő másodperc becsülve; 0 = nem számítható. */
  etaSec: number;
  status: 'downloading' | 'cached' | 'loading' | 'ready' | 'error';
}

/** Folyamatjelző callback modellbetöltéshez. */
export type InitProgressCallback = (progress: LoadProgress) => void;

// ---------------------------------------------------------------------------
// Worker protokoll
// ---------------------------------------------------------------------------

/** Kérés a főszál → worker irányba. Válasz `WorkerResponse`-ban, azonos `id`-vel. */
export interface WorkerRequest<T = unknown> {
  id: string;
  type: 'load' | 'chat' | 'unload' | 'status';
  payload?: T;
}

/**
 * Válasz worker → főszál irányba.
 * - `type: 'chunk'` streaming részlet, `ok: true`, `data` a delta.
 * - `type: 'result'` végeredmény, `ok: true`, `data` a payload.
 * - `type: 'error'` hiba, `ok: false`, `error` üzenettel.
 */
export interface WorkerResponse<T = unknown> {
  id: string;
  type: 'chunk' | 'result' | 'error';
  ok: boolean;
  data?: T;
  error?: string;
}

/** Motor eseménynevek az `on`/`off` feliratkozáshoz. */
export type EngineEventName =
  | 'model-loading'
  | 'model-ready'
  | 'model-error'
  | 'progress'
  | 'memory';
