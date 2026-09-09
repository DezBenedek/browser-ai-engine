// src/adapters/react.ts
// React adapter: useBrowserAI hook. Egyetlen runtime import: "react" (peer).
// SSR-safe: Engine példányosítás csak kliensen, eseménykezelőben/effektben;
// szerveren a hook az alapállapotot adja, a műveletek hibával térnek vissza.
// Feltételezett Engine API (lásd src/core/Engine.ts):
//   loadModel(id, { onProgress? }) / chat(messages, { onToken?, signal?, ... })
//   / unload() / dispose(). Eltérés esetén ezt a fájlt kell igazítani.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserAIEngine } from "../core/Engine.js";
import type { ChatMessage, LoadProgress } from "../core/types.js";

export type { BrowserAIEngine } from "../core/Engine.js";
export type { ChatMessage, LoadProgress } from "../core/types.js";

export interface UseBrowserAIOptions {
  modelId?: string;
  autoLoad?: boolean;
}

export interface UseBrowserAIState {
  ready: boolean;
  loading: boolean;
  progress: LoadProgress | null;
  error: string | null;
  currentModel: string | null;
}

export interface ChatCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

export interface UseBrowserAIReturn extends UseBrowserAIState {
  loadModel: (modelId: string) => Promise<void>;
  chat: (messages: ChatMessage[], opts?: ChatCallOptions) => Promise<string>;
  unload: () => Promise<void>;
}

const INITIAL: UseBrowserAIState = {
  ready: false,
  loading: false,
  progress: null,
  error: null,
  currentModel: null,
};

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof document !== "undefined";

export function useBrowserAI(options: UseBrowserAIOptions = {}): UseBrowserAIReturn {
  const { modelId, autoLoad = false } = options;
  const engineRef = useRef<BrowserAIEngine | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<UseBrowserAIState>(INITIAL);

  // Dinamikus import: az Engine nem kerül a szerver bundle kritikus útjába.
  const ensureEngine = useCallback(async (): Promise<BrowserAIEngine> => {
    if (!isBrowser()) throw new Error("useBrowserAI csak kliens oldalon használható.");
    if (!engineRef.current) {
      const mod = await import("../core/Engine.js");
      engineRef.current = new mod.BrowserAIEngine();
    }
    return engineRef.current;
  }, []);

  const loadModel = useCallback(
    async (id: string): Promise<void> => {
      setState((s) => ({ ...s, loading: true, error: null, progress: null }));
      try {
        const engine = await ensureEngine();
        await engine.loadModel(id, (progress: LoadProgress) => {
          if (mountedRef.current) setState((s) => ({ ...s, progress }));
        });
        if (mountedRef.current) {
          setState((s) => ({ ...s, loading: false, ready: true, currentModel: id }));
        }
      } catch (err) {
        if (mountedRef.current) {
          setState((s) => ({
            ...s,
            loading: false,
            ready: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        throw err;
      }
    },
    [ensureEngine],
  );

  const chat = useCallback(
    async (messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> => {
      const engine = await ensureEngine();
      if (!engine) throw new Error("chat: engine nem elérhető.");
      setState((s) => ({ ...s, error: null }));
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
        if (mountedRef.current) {
          setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        throw err;
      }
    },
    [ensureEngine],
  );

  const unload = useCallback(async (): Promise<void> => {
    const engine = engineRef.current;
    engineRef.current = null;
    await engine?.unload();
    if (mountedRef.current) {
      setState((s) => ({ ...s, ready: false, currentModel: null, progress: null }));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (autoLoad && modelId && isBrowser()) {
      void loadModel(modelId);
    }
    return () => {
      mountedRef.current = false;
      const engine = engineRef.current;
      engineRef.current = null;
      void engine?.dispose();
    };
    // loadModel stabil (useCallback), modelId/autoLoad egyszeri döntés.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...state, loadModel, chat, unload };
}
