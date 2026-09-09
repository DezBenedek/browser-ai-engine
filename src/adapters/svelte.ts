// src/adapters/svelte.ts
// Svelte adapter: createBrowserAIStore + browserAIStore singleton.
// Csak "svelte/store" runtime import. A writable-ek létrehozása DOM-mentes,
// ezért a modul SSR alatt is importálható; Engine csak kliensen, metódushívásra jön létre.
// Feltételezett Engine API megegyezik a react adapterével (lásd src/adapters/react.ts).

import { get, writable } from "svelte/store";
import type { Readable } from "svelte/store";
import type { BrowserAIEngine } from "../core/Engine.js";
import type { ChatMessage, LoadProgress } from "../core/types.js";

export type { BrowserAIEngine } from "../core/Engine.js";
export type { ChatMessage, LoadProgress } from "../core/types.js";

export interface BrowserAIStoreOptions {
  modelId?: string;
}

export interface ChatCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

export interface BrowserAIStore {
  ready: Readable<boolean>;
  loading: Readable<boolean>;
  progress: Readable<LoadProgress | null>;
  error: Readable<string | null>;
  currentModel: Readable<string | null>;
  loadModel: (modelId: string) => Promise<void>;
  chat: (messages: ChatMessage[], opts?: ChatCallOptions) => Promise<string>;
  unload: () => Promise<void>;
  dispose: () => Promise<void>;
}

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof document !== "undefined";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBrowserAIStore(
  options: BrowserAIStoreOptions = {},
): BrowserAIStore {
  const ready = writable(false);
  const loading = writable(false);
  const progress = writable<LoadProgress | null>(null);
  const error = writable<string | null>(null);
  const currentModel = writable<string | null>(null);

  let engine: BrowserAIEngine | null = null;
  // Modellezett autoLoad: csak kliensen, egyszer.
  let autoLoadStarted = false;

  async function ensureEngine(): Promise<BrowserAIEngine> {
    if (!isBrowser()) throw new Error("createBrowserAIStore: engine csak kliens oldalon hozható létre.");
    if (!engine) {
      const mod = await import("../core/Engine.js");
      engine = new mod.BrowserAIEngine();
    }
    return engine;
  }

  async function loadModel(modelId: string): Promise<void> {
    loading.set(true);
    error.set(null);
    progress.set(null);
    try {
      const e = await ensureEngine();
      await e.loadModel(modelId, (p: LoadProgress) => progress.set(p));
      loading.set(false);
      ready.set(true);
      currentModel.set(modelId);
    } catch (err) {
      loading.set(false);
      ready.set(false);
      error.set(toMessage(err));
      throw err;
    }
  }

  async function chat(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
    const e = await ensureEngine();
    error.set(null);
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
      error.set(toMessage(err));
      throw err;
    }
  }

  async function unload(): Promise<void> {
    const e = engine;
    engine = null;
    await e?.unload();
    ready.set(false);
    currentModel.set(null);
    progress.set(null);
  }

  async function dispose(): Promise<void> {
    const e = engine;
    engine = null;
    await e?.dispose();
    ready.set(false);
    loading.set(false);
    currentModel.set(null);
    progress.set(null);
  }

  // autoLoad: get() szinkron, mellékhatás csak kliensen és egyszer.
  if (options.modelId && isBrowser() && !autoLoadStarted) {
    autoLoadStarted = true;
    void loadModel(options.modelId);
  }

  return { ready, loading, progress, error, currentModel, loadModel, chat, unload, dispose };
}

/** Megosztott singleton. Létrehozása DOM-mentes, SSR-safe. */
export const browserAIStore: BrowserAIStore = createBrowserAIStore();

/** Kényelmi segéd template-kódnak: aktuális ready érték lekérése. */
export function isStoreReady(store: BrowserAIStore = browserAIStore): boolean {
  return get(store.ready);
}
