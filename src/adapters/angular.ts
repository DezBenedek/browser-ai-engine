// src/adapters/angular.ts
// Angular adapter: BrowserAIService. Egyetlen runtime import: "@angular/core" (peer).
// Angular 17+ signálokra épül; SSR alatt (Angular Universal) az állapot az
// alapértelmezett, az Engine csak kliensen, az első metódushívásra jön létre.
// Használat: injektáld a komponenbe, takarításhoz hívd a destroy()-t
// az ngOnDestroy-ban (vagy hagyd a root-szolgáltatást élni).

import { Injectable, signal } from '@angular/core';
import type { WritableSignal } from '@angular/core';
import type { BrowserAIEngine } from '../core/Engine.js';
import type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export type { BrowserAIEngine } from '../core/Engine.js';
export type { ChatMessage, EngineOptions, LoadProgress } from '../core/types.js';

export interface ChatCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

const isBrowser = (): boolean => typeof window !== 'undefined';

@Injectable({ providedIn: 'root' })
export class BrowserAIService {
  readonly ready: WritableSignal<boolean> = signal(false);
  readonly loading: WritableSignal<boolean> = signal(false);
  readonly progress: WritableSignal<LoadProgress | null> = signal(null);
  readonly error: WritableSignal<string | null> = signal(null);
  readonly currentModel: WritableSignal<string | null> = signal(null);

  private engine: BrowserAIEngine | null = null;
  private engineOptions: EngineOptions | undefined;

  /** Motoropciók beállítása az első használat előtt (opcionális). */
  configure(engineOptions: EngineOptions): void {
    this.engineOptions = engineOptions;
  }

  async loadModel(modelId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.progress.set(null);
    try {
      const engine = await this.ensureEngine();
      await engine.loadModel(modelId, (p: LoadProgress) => this.progress.set(p));
      this.loading.set(false);
      this.ready.set(true);
      this.currentModel.set(modelId);
    } catch (err) {
      this.loading.set(false);
      this.ready.set(false);
      this.error.set(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async chat(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
    const engine = await this.ensureEngine();
    this.error.set(null);
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
      this.error.set(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async unload(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    await engine?.unload();
    this.ready.set(false);
    this.currentModel.set(null);
    this.progress.set(null);
  }

  /** Teljes takarítás (pl. ngOnDestroy-ban). */
  async destroy(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    await engine?.dispose();
    this.ready.set(false);
    this.loading.set(false);
    this.currentModel.set(null);
    this.progress.set(null);
    this.error.set(null);
  }

  private async ensureEngine(): Promise<BrowserAIEngine> {
    if (!isBrowser()) throw new Error('BrowserAIService csak kliens oldalon használható.');
    if (!this.engine) {
      const mod = await import('../core/Engine.js');
      this.engine = new mod.BrowserAIEngine(this.engineOptions);
    }
    return this.engine;
  }
}
