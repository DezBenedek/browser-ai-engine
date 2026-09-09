// src/adapters/solid.ts
// SolidJS adapter: useBrowserAI primitív. Egyetlen runtime import: "solid-js" (peer).
// SSR-safe: Engine csak kliensen, az első metódushívásra példányosodik.

import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
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
  ready: Accessor<boolean>;
  loading: Accessor<boolean>;
  progress: Accessor<LoadProgress | null>;
  error: Accessor<string | null>;
  currentModel: Accessor<string | null>;
  loadModel: (modelId: string) => Promise<void>;
  chat: (messages: ChatMessage[], opts?: ChatCallOptions) => Promise<string>;
  unload: () => Promise<void>;
}

const isBrowser = (): boolean => typeof window !== 'undefined';

export function useBrowserAI(options: UseBrowserAIOptions = {}): UseBrowserAIReturn {
  const { modelId, autoLoad = false, engineOptions } = options;
  let engine: BrowserAIEngine | null = null;
  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [progress, setProgress] = createSignal<LoadProgress | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [currentModel, setCurrentModel] = createSignal<string | null>(null);

  async function ensureEngine(): Promise<BrowserAIEngine> {
    if (!isBrowser()) throw new Error('useBrowserAI csak kliens oldalon használható.');
    if (!engine) {
      const mod = await import('../core/Engine.js');
      engine = new mod.BrowserAIEngine(engineOptions);
    }
    return engine;
  }

  async function loadModel(id: string): Promise<void> {
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const e = await ensureEngine();
      await e.loadModel(id, (p: LoadProgress) => setProgress(p));
      setLoading(false);
      setReady(true);
      setCurrentModel(id);
    } catch (err) {
      setLoading(false);
      setReady(false);
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function chat(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
    const e = await ensureEngine();
    setError(null);
    try {
      const res = await e.chat({
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onChunk: opts.onToken,
      });
      return res.text;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function unload(): Promise<void> {
    const e = engine;
    engine = null;
    await e?.unload();
    setReady(false);
    setCurrentModel(null);
    setProgress(null);
  }

  if (autoLoad && modelId && isBrowser()) {
    void loadModel(modelId).catch(() => undefined);
  }

  onCleanup(() => {
    const e = engine;
    engine = null;
    void e?.dispose().catch(() => undefined);
  });

  return { ready, loading, progress, error, currentModel, loadModel, chat, unload };
}
