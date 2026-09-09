/**
 * PipelineModule: általános transformers.js futtató a nem-chat feladatokhoz.
 *
 * - A modellt a registryből oldja fel (`getModel`), a futtatást a
 *   transformers.js `pipeline()` végzi — `@xenova/transformers` kizárólag
 *   metódushíváson belül, dynamic importtal töltődik (SSR-safe).
 * - Chat feladatra hibát dob: arra az Engine/WebLLM való (`engine.chat`).
 * - Bemenet feladattól függ: szöveg, kép (Blob/Canvas), hang (Float32Array/Blob).
 *   A modul nem konvertál, csak továbbad — dekódoláshoz lásd AudioModule.
 */

import { getModel } from '../core/registry.js';
import type { ModelInfo } from '../core/types.js';
import type { ModelTask } from '../core/types.js';
import { importTransformers } from '../core/loader.js';

/** Registry-task → transformers.js pipeline-név. Chat szándékosan nincs benne. */
const TASK_TO_PIPELINE: Record<Exclude<ModelTask, 'chat'>, string> = {
  stt: 'automatic-speech-recognition',
  tts: 'text-to-speech',
  embedding: 'feature-extraction',
  rerank: 'text-classification',
  'text-classification': 'text-classification',
  'zero-shot': 'zero-shot-classification',
  qa: 'question-answering',
  summarization: 'summarization',
  text2text: 'text2text-generation',
  translation: 'translation',
  'image-classification': 'image-classification',
  'object-detection': 'object-detection',
  segmentation: 'image-segmentation',
  ocr: 'image-to-text',
};

export interface PipelineRunOptions {
  /**
   * Feladatspecifikus második argumentum a pipeline-nak.
   * Pl. QA-nál `{ question }`, zero-shotnál `{ candidate_labels }`,
   * summarizationnél `{ max_new_tokens }`.
   */
  taskOptions?: unknown;
  onProgress?: (progress: unknown) => void;
}

export class PipelineModule {
  /** Betöltött pipeline-ok `feladat::modell` kulcson. */
  private readonly pipelines = new Map<string, Promise<unknown>>();
  private readonly useCache: boolean;

  constructor(opts: { useCache?: boolean } = {}) {
    this.useCache = opts.useCache ?? true;
  }

  /**
   * Modell futtatása tetszőleges bemeneten. Kimenet a pipeline nyers válasza.
   * Példa: `await pipes.run('sentiment-distilbert', 'I love this!')`.
   */
  async run(modelId: string, input: unknown, opts: PipelineRunOptions = {}): Promise<unknown> {
    const info = this.resolve(modelId, 'run');
    if (typeof window === 'undefined') {
      throw new Error('PipelineModule.run: csak böngészőben fut (nincs window-objektum).');
    }
    const pipelineName = TASK_TO_PIPELINE[info.task];
    const pipe = await this.loadPipeline(pipelineName, info.hfRepo as string, opts.onProgress);
    const fn = pipe as (input: unknown, options?: unknown) => Promise<unknown>;
    return opts.taskOptions === undefined
      ? fn(input)
      : fn(input, opts.taskOptions);
  }

  /**
   * Súlyok előtöltése futtatás nélkül: a pipeline létrejön (a transformers.js
   * ilyenkor tölti le a fájlokat), a visszaadott példány újrafelhasználható.
   * Erre épül az Engine `loadModel` transformers-ága is.
   */
  async warmup(modelId: string, onProgress?: (progress: unknown) => void): Promise<unknown> {
    const info = this.resolve(modelId, 'warmup');
    if (typeof window === 'undefined') {
      throw new Error('PipelineModule.warmup: csak böngészőben fut (nincs window-objektum).');
    }
    return this.loadPipeline(TASK_TO_PIPELINE[info.task], info.hfRepo as string, onProgress);
  }

  /** Támogatott feladat → pipeline-név feloldása (tesztelhető, tiszta). */
  static pipelineFor(task: Exclude<ModelTask, 'chat'>): string {
    return TASK_TO_PIPELINE[task];
  }

  private resolve(modelId: string, method: string): ModelInfo & { task: Exclude<ModelTask, 'chat'> } {
    const info = getModel(modelId);
    if (!info) {
      throw new Error(`PipelineModule.${method}: ismeretlen modell "${modelId}".`);
    }
    if (info.task === 'chat') {
      throw new Error(
        `PipelineModule.${method}: "${modelId}" chat modell, használd az Engine.chat()-et.`,
      );
    }
    if (!info.hfRepo) {
      throw new Error(`PipelineModule.${method}: "${modelId}" modellhez nincs hfRepo (placeholder?).`);
    }
    return info as ModelInfo & { task: Exclude<ModelTask, 'chat'> };
  }

  private async loadPipeline(
    task: string,
    model: string,
    onProgress?: (p: unknown) => void,
  ): Promise<unknown> {
    const key = `${task}::${model}`;
    const cached = this.pipelines.get(key);
    if (cached !== undefined) return cached;
    const pending = this.loadTransformers().then((mod) =>
      mod.pipeline(task, model, {
        ...(onProgress !== undefined ? { progress_callback: onProgress } : {}),
      }),
    );
    pending.catch(() => {
      this.pipelines.delete(key);
    });
    this.pipelines.set(key, pending);
    return pending;
  }

  private async loadTransformers(): Promise<{
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
  }> {
    const mod = await importTransformers();
    // `cache.enabled === false` az Engine-ben: ne írjon a böngészős tárba.
    try {
      if (mod.env && this.useCache === false) mod.env.useBrowserCache = false;
    } catch {
      // env-flag best-effort: nem blokkol.
    }
    return mod;
  }
}
