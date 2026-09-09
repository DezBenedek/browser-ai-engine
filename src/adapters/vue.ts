// src/adapters/vue.ts
// Vue 3 adapter: useBrowserAI composable. Egyetlen runtime import: "vue" (peer).
// SSR-safe: Engine csak kliensen, az első metódushívásra példányosodik;
// szerveren az alapállapotot adja, a műveletek hibával térnek vissza.

import { onScopeDispose, ref, shallowRef } from 'vue';
import type { Ref, ShallowRef } from 'vue';
import type { BrowserAIEngine } from '../core/Engine.js';
import type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export type { BrowserAIEngine } from '../core/Engine.js';
export type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export interface UseBrowserAIOptions {
  modelId?: string;
  autoLoad?: boolean;
  engineOptions?: EngineOptions;
}

export interface ChatCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

export interface UseBrowserAIReturn {
  ready: Ref<boolean>;
  loading: Ref<boolean>;
  progress: Ref<LoadProgress | null>;
  error: Ref<string | null>;
  currentModel: Ref<string | null>;
  loadModel: (modelId: string) => Promise<void>;
  chat: (messages: ChatMessage[], opts?: ChatCallOptions) => Promise<string>;
  unload: () => Promise<void>;
}

const isBrowser = (): boolean => typeof window !== 'undefined';

export function useBrowserAI(options: UseBrowserAIOptions = {}): UseBrowserAIReturn {
  const { modelId, autoLoad = false, engineOptions } = options;
  const engineRef: ShallowRef<BrowserAIEngine | null> = shallowRef(null);
  const ready = ref(false);
  const loading = ref(false);
  const progress = ref<LoadProgress | null>(null);
  const error = ref<string | null>(null);
  const currentModel = ref<string | null>(null);

  async function ensureEngine(): Promise<BrowserAIEngine> {
    if (!isBrowser()) throw new Error('useBrowserAI csak kliens oldalon használható.');
    if (!engineRef.value) {
      const mod = await import('../core/Engine.js');
      engineRef.value = new mod.BrowserAIEngine(engineOptions);
    }
    return engineRef.value;
  }

  async function loadModel(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    progress.value = null;
    try {
      const engine = await ensureEngine();
      await engine.loadModel(id, (p: LoadProgress) => {
        progress.value = p;
      });
      loading.value = false;
      ready.value = true;
      currentModel.value = id;
    } catch (err) {
      loading.value = false;
      ready.value = false;
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function chat(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
    const engine = await ensureEngine();
    error.value = null;
    try {
      const res = await engine.chat({
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onChunk: opts.onToken,
      });
      return res.text;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function unload(): Promise<void> {
    const engine = engineRef.value;
    engineRef.value = null;
    await engine?.unload();
    ready.value = false;
    currentModel.value = null;
    progress.value = null;
  }

  if (autoLoad && modelId && isBrowser()) {
    void loadModel(modelId).catch(() => undefined);
  }

  onScopeDispose(() => {
    const engine = engineRef.value;
    engineRef.value = null;
    void engine?.dispose().catch(() => undefined);
  });

  return { ready, loading, progress, error, currentModel, loadModel, chat, unload };
}
