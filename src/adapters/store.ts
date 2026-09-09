/**
 * Vanilla (keretrendszer-független) store a BrowserAIEngine köré.
 *
 * - Függőségmentes, DOM-mentes: Node-ban/SSR-ben is importálható, az Engine
 *   csak az első metódushíváskor példányosodik (böngésző-őrrel).
 * - `subscribe` / `getSnapshot` alakja React `useSyncExternalStore`-kompatibilis,
 *   de Svelte/Vue/Solid felől is közvetlenül használható.
 */

import type { BrowserAIEngine } from '../core/Engine.js';
import type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export type { BrowserAIEngine } from '../core/Engine.js';
export type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export interface VanillaStoreOptions {
  modelId?: string;
  engineOptions?: EngineOptions;
}

export interface ChatCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

export interface BrowserAIState {
  ready: boolean;
  loading: boolean;
  progress: LoadProgress | null;
  error: string | null;
  currentModel: string | null;
}

export type StoreListener = (state: BrowserAIState) => void;

const INITIAL: BrowserAIState = {
  ready: false,
  loading: false,
  progress: null,
  error: null,
  currentModel: null,
};

const isBrowser = (): boolean => typeof window !== 'undefined';

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BrowserAIStoreInstance {
  getState: () => BrowserAIState;
  getSnapshot: () => BrowserAIState;
  subscribe: (listener: StoreListener) => () => void;
  loadModel: (modelId: string) => Promise<void>;
  chat: (messages: ChatMessage[], opts?: ChatCallOptions) => Promise<string>;
  unload: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function createBrowserAI(options: VanillaStoreOptions = {}): BrowserAIStoreInstance {
  let state: BrowserAIState = { ...INITIAL };
  const listeners = new Set<StoreListener>();
  let engine: BrowserAIEngine | null = null;

  function setState(patch: Partial<BrowserAIState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch {
        // Listener-hiba nem terjedhet a store működésére.
      }
    }
  }

  async function ensureEngine(): Promise<BrowserAIEngine> {
    if (!isBrowser()) throw new Error('createBrowserAI: engine csak kliens oldalon hozható létre.');
    if (!engine) {
      const mod = await import('../core/Engine.js');
      engine = new mod.BrowserAIEngine(options.engineOptions);
    }
    return engine;
  }

  async function loadModel(modelId: string): Promise<void> {
    setState({ loading: true, error: null, progress: null });
    try {
      const e = await ensureEngine();
      await e.loadModel(modelId, (p: LoadProgress) => setState({ progress: p }));
      setState({ loading: false, ready: true, currentModel: modelId });
    } catch (err) {
      setState({ loading: false, ready: false, error: toMessage(err) });
      throw err;
    }
  }

  async function chat(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
    const e = await ensureEngine();
    setState({ error: null });
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
      setState({ error: toMessage(err) });
      throw err;
    }
  }

  async function unload(): Promise<void> {
    const e = engine;
    engine = null;
    await e?.unload();
    setState({ ready: false, currentModel: null, progress: null });
  }

  async function dispose(): Promise<void> {
    const e = engine;
    engine = null;
    listeners.clear();
    await e?.dispose();
    state = { ...INITIAL };
  }

  function subscribe(listener: StoreListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  const store: BrowserAIStoreInstance = {
    getState: () => state,
    getSnapshot: () => state,
    subscribe,
    loadModel,
    chat,
    unload,
    dispose,
  };

  if (options.modelId && isBrowser()) {
    void loadModel(options.modelId).catch(() => undefined);
  }

  return store;
}
