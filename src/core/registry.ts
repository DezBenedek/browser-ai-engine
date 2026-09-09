/**
 * Modellregiszter: ismert modellek metaadatai + lekérdező helperök.
 *
 * Konvenciók:
 * - WebLLM modellek: `modelUrl` a HuggingFace `.../resolve/main/` végpontra mutat,
 *   ez kerül a WebLLM `appConfig.model_list` bejegyzés `model` mezőjébe.
 * - transformers.js modellek: `hfRepo` a Hub repo azonosító, a súlyok
 *   betöltése az AudioModule/Embedding modulban történik (lazy).
 * - `sizeMB` / `vramMB` közelítő értékek; UI kijelzésre és
 *   progress-becslésre szolgálnak, nem kvótakezelésre.
 */

import type { ModelInfo, ModelTask } from './types.js';

/** Alapértelmezett modell: legkisebb VRAM-igényű chat modell. */
export const DEFAULT_MODEL = 'qwen-2.5-0.5b';

/** Ismert modellek szótára id → metaadat. */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'qwen-2.5-0.5b': {
    id: 'qwen-2.5-0.5b',
    label: 'Qwen2.5 0.5B Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 400,
    params: '0.5B',
    contextWindow: 4096,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 1400,
    description: 'Legkisebb chat modell; gyenge GPU-n / teszteléshez ajánlott.',
  },
  'qwen-2.5-1.5b': {
    id: 'qwen-2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 1100,
    params: '1.5B',
    contextWindow: 4096,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 2600,
    description: 'Jó minőség/méret arány általános csevegésre.',
  },
  'qwen-2.5-3b': {
    id: 'qwen-2.5-3b',
    label: 'Qwen2.5 3B Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 2200,
    params: '3B',
    contextWindow: 4096,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 4200,
    description: 'Erősebb érvelés és tool-calling hajlam; 4 GB+ VRAM kell.',
  },
  'llama-3.2-1b': {
    id: 'llama-3.2-1b',
    label: 'Llama 3.2 1B Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 900,
    params: '1B',
    contextWindow: 8192,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 2400,
    description: 'Meta Llama 3.2 kis modell; rövid instrukciókövetésre jó.',
  },
  'llama-3.2-3b': {
    id: 'llama-3.2-3b',
    label: 'Llama 3.2 3B Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 2400,
    params: '3B',
    contextWindow: 8192,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 4400,
    description: 'Llama 3.2 nagyobb modell; összefoglalásra, RAG-ra alkalmas.',
  },
  'phi-3.5-mini': {
    id: 'phi-3.5-mini',
    label: 'Phi-3.5-mini Instruct (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/Phi-3.5-mini-instruct-q4f16_1-MLC/resolve/main/',
    sizeMB: 2700,
    params: '3.8B',
    contextWindow: 4096,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 4800,
    description: 'Microsoft Phi kis modell; kód- és érvelési feladatokra erős.',
  },
  'gemma-2-2b': {
    id: 'gemma-2-2b',
    label: 'Gemma 2 2B IT (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/gemma-2-2b-it-q4f16_1-MLC/resolve/main/',
    sizeMB: 1800,
    params: '2B',
    contextWindow: 8192,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 3600,
    description: 'Google Gemma 2; fegyelmezett instrukciókövetés.',
  },
  'deepseek-r1-distill-qwen-1.5b': {
    id: 'deepseek-r1-distill-qwen-1.5b',
    label: 'DeepSeek-R1-Distill-Qwen 1.5B (q4f16_1)',
    provider: 'webllm',
    modelUrl:
      'https://huggingface.co/mlc-ai/DeepSeek-R1-Distill-Qwen-1.5B-q4f16_1-MLC/resolve/main/',
    sizeMB: 1200,
    params: '1.5B',
    contextWindow: 4096,
    quantization: 'q4f16_1',
    task: 'chat',
    vramMB: 2800,
    description: 'Érvelésre desztillált modell; lépésenkénti gondolkodást ír ki.',
  },
  'whisper-tiny': {
    id: 'whisper-tiny',
    label: 'Whisper Tiny (transformers.js)',
    provider: 'transformers',
    hfRepo: 'Xenova/whisper-tiny',
    sizeMB: 150,
    params: '39M',
    contextWindow: 448,
    task: 'stt',
    vramMB: 500,
    description: 'Valós idejű beszédfelismerés CPU-n; pontossága korlátozott.',
  },
  'whisper-base': {
    id: 'whisper-base',
    label: 'Whisper Base (transformers.js)',
    provider: 'transformers',
    hfRepo: 'Xenova/whisper-base',
    sizeMB: 250,
    params: '74M',
    contextWindow: 448,
    task: 'stt',
    vramMB: 700,
    description: 'Jobb pontosságú STT; még CPU-barát méret.',
  },
  'tts-kokoro': {
    id: 'tts-kokoro',
    label: 'Kokoro TTS (placeholder)',
    provider: 'transformers',
    sizeMB: 350,
    params: '82M',
    contextWindow: 512,
    task: 'tts',
    vramMB: 800,
    description:
      'Placeholder: Kokoro 82M súlyok érkezésekor `hfRepo` + `modelUrl` pótlása.',
  },
  speecht5: {
    id: 'speecht5',
    label: 'SpeechT5 TTS (transformers.js)',
    provider: 'transformers',
    hfRepo: 'Xenova/speecht5_tts',
    sizeMB: 320,
    params: '100M',
    contextWindow: 512,
    task: 'tts',
    vramMB: 800,
    description: 'Beszédszintézis CPU-n; beszélő-embeddinget igényel.',
  },
  'snowflake-arctic-embed-xs': {
    id: 'snowflake-arctic-embed-xs',
    label: 'Snowflake Arctic Embed XS',
    provider: 'transformers',
    hfRepo: 'Xenova/snowflake-arctic-embed-xs',
    sizeMB: 180,
    params: '22M',
    contextWindow: 512,
    task: 'embedding',
    vramMB: 500,
    description: 'Könnyű beágyazó modell RAG / szemantikus kereséshez.',
  },
};

/** Regiszter tömb formában (UI listákhoz, stabil sorrendben). */
export const MODEL_LIST: ModelInfo[] = Object.values(MODEL_REGISTRY);

/**
 * Modell metaadat lekérése id alapján.
 * @returns A modell infoja, vagy `undefined` ha ismeretlen.
 */
export function getModel(id: string): ModelInfo | undefined {
  return MODEL_REGISTRY[id];
}

/**
 * Modellek listázása, opcionálisan feladatra szűrve.
 */
export function listModels(task?: ModelTask): ModelInfo[] {
  if (task === undefined) return [...MODEL_LIST];
  return MODEL_LIST.filter((m) => m.task === task);
}

/** Igaz, ha az id szerepel a regiszterben. */
export function isKnownModel(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_REGISTRY, id);
}
