/**
 * BrowserAIEngine: böngészőben futó LLM motor (WebLLM + transformers.js).
 *
 * - Chat modellek WebLLM-mel (WebGPU), STT/TTS/embedding súlyok lazy
 *   betöltéssel az AudioModule-ben; `loadModel` transformers feladatnál
 *   csak előtölt + `ready`-t jelez.
 * - Worker bekapcsolva (`worker.enabled`) a nehéz hívások workeren futnak,
 *   különben főszálon. A worker URL csak `ensure()`-ben oldódik fel.
 * - UI widget és Tool/Audio modulok dinamikus `import()`-tal, sosem
 *   blokkolják a motor indulását.
 *
 * tsconfig igény: `module/moduleResolution` ESM (`Bundler`/`NodeNext`),
 * `lib: ["DOM", "DOM.Iterable", "ESNext"]`.
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatToolCall,
  EngineEventName,
  EngineOptions,
  InitProgressCallback,
  LoadProgress,
  ModelInfo,
  ToolDefinition,
} from './types.js';
import { getModel, listModels as registryListModels, listModelsByCategory } from './registry.js';
import { CacheManager } from './CacheManager.js';
import {
  WorkerManager,
  WORKER_DISABLED,
  normalizeWorkerChatResult,
  normalizeWorkerProgress,
  normalizeWorkerToken,
} from './WorkerManager.js';
import { importWebLLM } from './loader.js';
import { AudioModule } from '../modules/AudioModule.js';
import type { TranscribeOptions, SynthesizeOptions } from '../modules/AudioModule.js';
import { PipelineModule } from '../modules/PipelineModule.js';
import type { ModelCategory, ModelTask } from './types.js';

// WebLLM streaming chunk minimális alakja (struktúrális típus, nem import).
interface StreamToolCallDelta {
  id?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}
interface StreamChoice {
  delta?: { content?: string; tool_calls?: StreamToolCallDelta[] };
  finish_reason?: string | null;
}
interface StreamChunk {
  choices?: StreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// WebLLM engine minimális felülete (lazán típusolva a verziófüggetlenségért).
interface MlcEngineLike {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<AsyncIterable<StreamChunk>>;
    };
  };
  unload?: () => Promise<void>;
}

type EventListener = (payload?: unknown) => void;

/** Modell metaadat gyorsítótár-státusszal (lásd `listModelsDetailed`). */
export interface ModelWithCache extends ModelInfo {
  cached: boolean;
}

const DEFAULT_CACHE_SCOPE = 'browser-ai-engine-v1';
/** tsup worker bundle neve a `dist/` mellett (lásd tsup.config.ts). */
const WORKER_DIST_FILE = 'inference.worker.global.js';
/** Forráselrendezés fejlesztéshez (src/core → src/worker). */
const WORKER_SRC_FILE = '../worker/inference.worker.js';

export class BrowserAIEngine {
  readonly options: Required<Pick<EngineOptions, 'autoEvict'>> & EngineOptions;
  currentModelId: string | null = null;

  readonly cache: CacheManager;
  private readonly workerMgr: WorkerManager;
  private mlcEngine: MlcEngineLike | null = null;
  private useWorker = false;
  private readonly listeners = new Map<EngineEventName, Set<EventListener>>();
  private widget: { destroy?: () => void } | null = null;
  private toolModulePromise: Promise<unknown> | null = null;
  private pipes: PipelineModule | null = null;

  constructor(options: EngineOptions = {}) {
    this.options = { autoEvict: true, ...options };
    const scope = options.cache?.scope ?? DEFAULT_CACHE_SCOPE;
    this.cache = new CacheManager(scope);
    // URL-feloldás halasztva: konstruktorban nincs `import.meta` mellékhatás.
    this.workerMgr = new WorkerManager(
      () => {
        try {
          const custom = options.worker?.url;
          if (custom) return custom;
          const base = import.meta.url;
          // dist/adapters/*.js → dist/inference.worker.global.js
          if (base.includes('/dist/adapters/')) {
            return new URL(`../${WORKER_DIST_FILE}`, base);
          }
          // dist/index.js → dist/inference.worker.global.js
          if (base.includes('/dist/')) {
            return new URL(`./${WORKER_DIST_FILE}`, base);
          }
          // src elrendezés (dev): src/core → src/worker
          return new URL(WORKER_SRC_FILE, base);
        } catch {
          return null;
        }
      },
      { enabled: options.worker?.enabled === true },
    );
  }

  // -- Események -----------------------------------------------------------

  /**
   * Feliratkozás motor-eseményre. Visszatérési érték a leiratkozó függvény.
   */
  on(event: EngineEventName, listener: EventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Leiratkozás motor-eseményről. */
  off(event: EngineEventName, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: EngineEventName, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        // Listener hiba nem terjedhet a motor működésére.
      }
    }
  }

  // -- Modellbetöltés ------------------------------------------------------

  /**
   * Modell betöltése és aktívvá tétele.
   *
   * - Ismeretlen id esetén hibát dob a regisztrált listával.
   * - `autoEvict` mellett az előző modell kipakolásra kerül.
   * - WebLLM (chat) modelleknél WebGPU ellenőrzés + `CreateMLCEngine`
   *   `appConfig`-gel; `initProgressCallback` az `onProgress`-be és
   *   `progress` eseményre fordítódik. A WebLLM a saját gyorsítótárát
   *   kezeli; külön előtöltés nem kell.
   * - transformers modelleknél (stt/tts/embedding/vision/…) a pipeline
   *   ténylegesen létrejön (`warmup`): a súlyok ilyenkor töltődnek le a
   *   transformers.js saját tárába, fájlonkénti folyamatjelzéssel.
   */
  async loadModel(modelId: string, onProgress?: InitProgressCallback): Promise<void> {
    const info = getModel(modelId);
    if (!info) {
      const known = registryListModels().map((m) => m.id).join(', ');
      throw new Error(`Ismeretlen modell: "${modelId}". Ismert modellek: ${known}.`);
    }
    if (this.currentModelId === modelId && this.mlcEngine) return;

    if (this.options.autoEvict && this.currentModelId && this.currentModelId !== modelId) {
      await this.unload();
    }

    this.emit('model-loading', { modelId });

    // Worker-út: ha van élő worker, a betöltést ő végzi.
    const worker = this.safeEnsureWorker();
    if (worker) {
      try {
        await this.workerMgr.call<void>(
          'load',
          { modelId },
          (chunk) => this.forwardWorkerProgress(modelId, chunk, onProgress),
        );
        this.currentModelId = modelId;
        this.useWorker = true;
        this.emitReady(modelId, onProgress);
        await this.ensureWidget();
        return;
      } catch (err) {
        if (!this.isWorkerDisabled(err)) throw err;
        // Worker-hiba `WORKER_DISABLED`: csendes visszaesés főszálra.
      }
    }

    if (info.provider === 'transformers' || info.task !== 'chat') {
      await this.warmupTransformerModel(info, onProgress);
      this.currentModelId = modelId;
      this.useWorker = false;
      this.emitReady(modelId, onProgress);
      await this.ensureWidget();
      return;
    }

    this.assertWebGPUAvailable();

    const report = (p: LoadProgress): void => {
      onProgress?.(p);
      this.emit('progress', p);
    };
    try {
      report(this.mkProgress(info, 0, 'loading'));
      // Bare import bundlerben/Node-ban, sima böngészőben CDN-visszaeséssel.
      const { CreateMLCEngine } = await importWebLLM();
      const createEngine = CreateMLCEngine as (
        model: string,
        config?: Record<string, unknown>,
      ) => Promise<MlcEngineLike>;
      const appConfig = {
        model_list: [{ model: info.modelUrl ?? info.id, model_id: info.id }],
      };
      const startedAt = Date.now();
      this.mlcEngine = await createEngine(info.id, {
        appConfig,
        initProgressCallback: (r: { progress?: number; text?: string }) => {
          const frac = typeof r?.progress === 'number' ? r.progress : 0;
          const total = info.sizeMB * 1024 * 1024;
          const loaded = Math.round(total * Math.min(1, Math.max(0, frac)));
          const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
          const mbPerSec = loaded / 1024 / 1024 / elapsedSec;
          const etaSec = mbPerSec > 0 ? (info.sizeMB - loaded / 1024 / 1024) / mbPerSec : 0;
          report({
            modelId: info.id,
            loadedBytes: loaded,
            totalBytes: total,
            percent: Math.round(frac * 100),
            mbPerSec: Math.round(mbPerSec * 10) / 10,
            etaSec: Math.round(etaSec),
            status: frac >= 1 ? 'loading' : 'downloading',
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('model-error', { modelId, error: msg });
      onProgress?.(this.mkProgress(info, 0, 'error'));
      throw err instanceof Error ? err : new Error(msg);
    }

    this.currentModelId = modelId;
    this.useWorker = false;
    this.emitReady(modelId, onProgress);
    await this.ensureWidget();
  }

  /**
   * Chat kérés az aktív modellen (streaming támogatással).
   *
   * - Betöltött modell nélkül informatív hibát dob (`loadModel` először).
   * - Natív tool-calling + JSON-emulációs fallback: `tools` megadásakor
   *   a rendszerprompt kiegészül a sémákkal; ha a válaszban nincs natív
   *   `tool_calls`, de a szöveg JSON eszközt hív, az visszakerül
   *   `toolCalls`-ba (ToolModule `extractJson`, majd lokális parser).
   * - `responseFormat: { type: 'json_object' }` továbbítódik a motornak.
   */
  async chat(options: ChatOptions): Promise<ChatResult> {
    if (!this.currentModelId) {
      throw new Error('Nincs betöltött modell. Hívd előbb: await engine.loadModel("<model-id>").');
    }
    const modelId = this.currentModelId;
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Megszakítva.');
    }

    if (this.useWorker && this.workerMgr.isActive()) {
      const raw = await this.workerMgr.call<unknown>(
        'chat',
        { modelId, ...this.serializeChatOptions(options) },
        (chunk) => {
          const delta = normalizeWorkerToken(chunk);
          if (delta) options.onChunk?.(delta);
        },
        options.signal,
      );
      const normalized = normalizeWorkerChatResult(raw, modelId);
      if (!normalized) {
        throw new Error('Worker chat: értelmezhetetlen válasz a workertől.');
      }
      return normalized;
    }

    if (!this.mlcEngine) {
      throw new Error(
        `A(z) "${modelId}" modell nincs főszálon betöltve. Hívd előbb: await engine.loadModel("${modelId}").`,
      );
    }

    const tools = options.tools ?? [];
    const messages: ChatMessage[] = tools.length > 0
      ? this.withToolFallbackInstruction(options.messages, tools)
      : [...options.messages];

    const body: Record<string, unknown> = {
      messages,
      stream: true,
      max_tokens: options.maxTokens ?? this.options.modelDefaults?.maxTokens,
      temperature: options.temperature ?? this.options.modelDefaults?.temperature,
      top_p: options.topP ?? this.options.modelDefaults?.topP,
    };
    if (tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (options.tool_choice && options.tool_choice !== 'none') {
        body['tool_choice'] = options.tool_choice === 'auto' ? 'auto' : options.tool_choice;
      }
    }
    if (options.responseFormat?.type === 'json_object') {
      body['response_format'] = { type: 'json_object' };
    }
    // `undefined` mezők törlése (WebLLM szigorú validálás ellen).
    for (const k of Object.keys(body)) {
      if (body[k] === undefined) delete body[k];
    }

    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = await this.mlcEngine.chat.completions.create(body);
    } catch (err) {
      // A modell elutasítja a `tools` paramétert: újra tisztán prompttal.
      if (tools.length > 0 && this.isToolParamError(err)) {
        const retry = { ...body };
        delete retry['tools'];
        delete retry['tool_choice'];
        stream = await this.mlcEngine.chat.completions.create(retry);
      } else {
        throw err;
      }
    }

    let text = '';
    const toolArgBuffers = new Map<number, { id?: string; name?: string; args: string }>();
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Megszakítva.');
      }
      const choice = chunk.choices?.[0];
      const deltaText = choice?.delta?.content ?? '';
      if (deltaText) {
        text += deltaText;
        options.onChunk?.(deltaText);
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let slot = toolArgBuffers.get(idx);
        if (!slot) {
          slot = { id: tc.id, args: '' };
          toolArgBuffers.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
      }
    }

    const toolCalls: ChatToolCall[] = [];
    for (const slot of toolArgBuffers.values()) {
      if (!slot.name) continue;
      toolCalls.push({
        name: slot.name,
        arguments: this.safeParseArgs(slot.args),
        ...(slot.id ? { id: slot.id } : {}),
      });
    }
    // Fallback: nincs natív hívás, de a szöveg JSON-t rejt.
    if (tools.length > 0 && toolCalls.length === 0) {
      const fb = await this.extractToolCallFallback(text, tools);
      if (fb) toolCalls.push(fb);
    }

    return { text, toolCalls, usage: { promptTokens, completionTokens }, modelId };
  }

  /** Aktív modell kipakolása a memóriából (idempotens). */
  async unload(): Promise<void> {
    if (this.useWorker && this.workerMgr.isActive()) {
      try {
        await this.workerMgr.call('unload', {});
      } catch {
        // Worker már halott: helyi állapot takarítása elég.
      }
    }
    if (this.mlcEngine?.unload) {
      try {
        await this.mlcEngine.unload();
      } catch {
        // Újratöltéskor a részleges állapot úgyis felülíródik.
      }
    }
    this.mlcEngine = null;
    this.currentModelId = null;
    this.useWorker = false;
  }

  /**
   * Memóriaállapot: aktív modell, JS heap (ha mérhető), WebGPU jelenlét.
   */
  getMemory(): { currentModel: string | null; heapMB?: number; gpu: boolean } {
    let heapMB: number | undefined;
    try {
      const perf = globalThis.performance as unknown as
        | { memory?: { usedJSHeapSize?: number } }
        | undefined;
      const bytes = perf?.memory?.usedJSHeapSize;
      if (typeof bytes === 'number') heapMB = Math.round((bytes / 1048576) * 10) / 10;
    } catch {
      heapMB = undefined;
    }
    const gpu =
      typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu != null;
    return {
      currentModel: this.currentModelId,
      ...(heapMB !== undefined ? { heapMB } : {}),
      gpu,
    };
  }

  /** Regisztrált modellek listája, opcionálisan feladatra szűrve. */
  listModels(task?: ModelTask): ModelInfo[] {
    return registryListModels(task);
  }

  /** Regisztrált modellek kategóriára szűrve. */
  listModelsByCategory(category: ModelCategory): ModelInfo[] {
    return listModelsByCategory(category);
  }

  /**
   * Modellista gyorsítótár-státusszal: minden bejegyzéshez `cached` flag.
   * A WebLLM és a transformers.js saját tárait is figyeli, nem csak a
   * saját scope-ot — ezért mutatja a ténylegesen letöltött modelleket.
   */
  async listModelsDetailed(task?: ModelTask): Promise<ModelWithCache[]> {
    const models = this.listModels(task);
    const flags = await Promise.all(models.map((m) => this.isModelCached(m)));
    return models.map((m, i) => ({ ...m, cached: flags[i] ?? false }));
  }

  /** Gyorsítótár ürítése (egy modell vagy a teljes scope). */
  async clearCache(modelId?: string): Promise<void> {
    await this.cache.clear(modelId);
  }

  /**
   * Teljes takarítás: worker leállítás, modell kipakolás, widget
   * megsemmisítés, listenerek törlése. Utána az engine eldobandó.
   */
  async dispose(): Promise<void> {
    this.listeners.clear();
    this.workerMgr.terminate();
    if (this.widget?.destroy) {
      try {
        this.widget.destroy();
      } catch {
        // UI-takarítási hiba nem blokkol.
      }
    }
    this.widget = null;
    await this.unload();
  }

  /**
   * WebGPU támogatás ellenőrzése (adapterkéréssel, nem csak API-jelenléttel).
   */
  static async isWebGPUSupported(): Promise<boolean> {
    try {
      const nav = globalThis.navigator as unknown as
        | { gpu?: { requestAdapter?: () => Promise<unknown> } }
        | undefined;
      if (!nav?.gpu?.requestAdapter) return false;
      const adapter = await nav.gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  // -- Belső segítők -------------------------------------------------------

  private safeEnsureWorker(): Worker | null {
    try {
      return this.workerMgr.ensure();
    } catch {
      return null;
    }
  }

  private isWorkerDisabled(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === WORKER_DISABLED
    );
  }

  private assertWebGPUAvailable(): void {
    if (typeof navigator === 'undefined') return; // SSR: WebLLM dob értelmes hibát.
    const nav = navigator as Navigator & { gpu?: unknown };
    if (nav.gpu == null) {
      throw new Error(
        'WebGPU nem elérhető ebben a böngészőben; WebLLM chat modell nem tölthető. ' +
          'Használj Chrome/Edge 113+ verziót (Safari 26+), vagy transformers feladatot (STT/TTS).',
      );
    }
  }

  private mkProgress(info: ModelInfo, percent: number, status: LoadProgress['status']): LoadProgress {
    const total = info.sizeMB * 1024 * 1024;
    return {
      modelId: info.id,
      loadedBytes: Math.round((total * percent) / 100),
      totalBytes: total,
      percent,
      mbPerSec: 0,
      etaSec: 0,
      status,
    };
  }

  private emitReady(modelId: string, onProgress?: InitProgressCallback): void {
    const info = getModel(modelId);
    const done: LoadProgress = info
      ? { ...this.mkProgress(info, 100, 'ready') }
      : {
          modelId,
          loadedBytes: 0,
          totalBytes: 0,
          percent: 100,
          mbPerSec: 0,
          etaSec: 0,
          status: 'ready' as const,
        };
    onProgress?.(done);
    this.emit('progress', done);
    this.emit('model-ready', { modelId });
    this.emit('memory', this.getMemory());
  }

  /** Egy modell súlyai megtalálhatók-e valamelyik böngészős tárban. */
  async isModelCached(info: ModelInfo): Promise<boolean> {
    try {
      if (await this.cache.has(info.id)) return true;
    } catch {
      // Saját scope olvashatatlan: nézzük a többi tárat is.
    }
    if (typeof caches === 'undefined') return false;
    const needles: string[] = [];
    if (info.hfRepo) needles.push(info.hfRepo);
    if (info.modelUrl) {
      try {
        // Pl. https://huggingface.co/mlc-ai/Qwen2.5-...-MLC/resolve/main/
        // → 'mlc-ai/Qwen2.5-...-MLC' részletre keresünk.
        const parts = new URL(info.modelUrl).pathname.split('/').filter(Boolean);
        if (parts.length >= 2) needles.push(`${parts[0]}/${parts[1]}`);
      } catch {
        // Érvénytelen URL: kihagyjuk.
      }
    }
    if (needles.length === 0) return false;
    try {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.some((r) => needles.some((n) => r.url.includes(n as string)))) return true;
      }
    } catch {
      // Tár-olvasási hiba: nem blokkol, nincs cache-találat.
    }
    return false;
  }

  /**
   * transformers pipeline tényleges létrehozása = valódi letöltés.
   * A transformers.js `progress_callback` fájlonkénti eseményeit összesítve
   * fordítja LoadProgress-re (bájtarány, sebesség, hátralévő idő).
   */
  private async warmupTransformerModel(info: ModelInfo, onProgress?: InitProgressCallback): Promise<void> {
    const report = (p: LoadProgress): void => {
      onProgress?.(p);
      this.emit('progress', p);
    };
    report(this.mkProgress(info, 0, 'downloading'));
    if (!this.pipes) {
      this.pipes = new PipelineModule({
        useCache: this.options.cache?.enabled !== false,
      });
    }
    const startedAt = Date.now();
    const files = new Map<string, { loaded: number; total: number }>();
    await this.pipes.warmup(info.id, (ev: unknown) => {
      const e = ev as { status?: string; file?: string; loaded?: number; total?: number } | null;
      if (!e || typeof e !== 'object') return;
      if (e.status === 'ready' || e.status === 'done') {
        if (typeof e.file === 'string') {
          const prev = files.get(e.file) ?? { loaded: 0, total: 0 };
          files.set(e.file, { loaded: Math.max(prev.loaded, prev.total), total: prev.total });
        }
      } else if (typeof e.file === 'string') {
        files.set(e.file, {
          loaded: typeof e.loaded === 'number' ? e.loaded : 0,
          total: typeof e.total === 'number' ? e.total : 0,
        });
      } else {
        return;
      }
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const expected = info.sizeMB * 1024 * 1024;
      const denom = total > 0 ? total : expected;
      const percent = denom > 0 ? Math.min(99, Math.round((loaded / denom) * 100)) : 0;
      const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
      const mbPerSec = loaded / 1024 / 1024 / elapsedSec;
      report({
        modelId: info.id,
        loadedBytes: loaded,
        totalBytes: total > 0 ? total : expected,
        percent,
        mbPerSec: Math.round(mbPerSec * 10) / 10,
        etaSec: mbPerSec > 0 ? Math.round((expected - loaded) / 1024 / 1024 / mbPerSec) : 0,
        status: 'downloading',
      });
    });
  }

  private forwardWorkerProgress(
    modelId: string,
    chunk: unknown,
    onProgress?: InitProgressCallback,
  ): void {
    const info = getModel(modelId);
    const full = normalizeWorkerProgress(chunk, modelId, info?.sizeMB ?? 0);
    if (!full) return;
    onProgress?.(full);
    this.emit('progress', full);
  }

  /** Workernek szerializálható chat paraméterek (függvények nélkül). */
  private serializeChatOptions(options: ChatOptions): Record<string, unknown> {
    return {
      messages: options.messages,
      tools: options.tools ?? [],
      tool_choice: options.tool_choice ?? 'auto',
      maxTokens: options.maxTokens ?? this.options.modelDefaults?.maxTokens,
      temperature: options.temperature ?? this.options.modelDefaults?.temperature,
      topP: options.topP ?? this.options.modelDefaults?.topP,
      responseFormat: options.responseFormat,
    };
  }

  /** Rendszerutasítás a tool-sémákkal gyenge natív támogatás esetére. */
  private withToolFallbackInstruction(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
    const schemas = tools
      .map((t) => `- ${t.name}: ${t.description}\n  JSON Schema: ${JSON.stringify(t.parameters)}`)
      .join('\n');
    const instruction: ChatMessage = {
      role: 'system',
      content:
        `Rendelkezésre álló eszközök:\n${schemas}\n\n` +
        'Ha eszközt kell hívni, a válasz legyen kizárólag egy JSON objektum: ' +
        '{"name": "<eszköz neve>", "arguments": {...}}. ' +
        'Egyébként válaszolj normál szöveggel.',
    };
    return [instruction, ...messages];
  }

  private isToolParamError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /tool|function|unsupported|unknown.*param/i.test(msg);
  }

  private safeParseArgs(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed; // Tört JSON: nyers sztring továbbadása.
    }
  }

  /**
   * JSON tool-hívás kinyerése szabad szövegből.
   * 1. ToolModule `extractJson` (ha az modul létezik),
   * 2. lokális `{...}` blokk keresés + névvalidálás.
   */
  private async extractToolCallFallback(text: string, tools: ToolDefinition[]): Promise<ChatToolCall | null> {
    const names = new Set(tools.map((t) => t.name));
    try {
      const mod = (await this.loadToolModule()) as Record<string, unknown> | null;
      const fn =
        (mod?.['extractJson'] as ((s: string) => unknown) | undefined) ??
        ((mod?.['ToolModule'] as Record<string, unknown> | undefined)?.['extractJson'] as
          | ((s: string) => unknown)
          | undefined);
      if (typeof fn === 'function') {
        const parsed = fn(text) as { name?: unknown; arguments?: unknown } | null;
        if (parsed && typeof parsed.name === 'string' && names.has(parsed.name)) {
          return { name: parsed.name, arguments: parsed.arguments ?? {} };
        }
      }
    } catch {
      // Hiányzó modul: lokális parserre esünk.
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as { name?: unknown; arguments?: unknown };
      if (parsed && typeof parsed.name === 'string' && names.has(parsed.name)) {
        return { name: parsed.name, arguments: parsed.arguments ?? {} };
      }
    } catch {
      // Nem JSON: nincs kinyerhető hívás.
    }
    return null;
  }

  private loadToolModule(): Promise<unknown> {
    if (!this.toolModulePromise) {
      this.toolModulePromise = import('../modules/ToolModule.js').catch(() => null);
    }
    return this.toolModulePromise;
  }

  /** Widget csak `ui.enabled` + böngésző esetén, hibája nem blokkol. */
  private async ensureWidget(): Promise<void> {
    if (this.options.ui?.enabled !== true) return;
    if (typeof window === 'undefined' || typeof document === 'undefined' || this.widget) return;
    try {
      const mod = (await import('../ui/Widget.js')) as Record<string, unknown>;
      const Ctor = (mod['FloatingWidget'] ?? mod['Widget'] ?? mod['default']) as
        | (new (opts: Record<string, unknown>) => { mount?: () => void; destroy?: () => void })
        | undefined;
      if (typeof Ctor !== 'function') return;
      const rawPos = this.options.ui?.position ?? 'bottom-right';
      const position = rawPos === 'top-right' || rawPos === 'top-left' ? 'bottom-right' : rawPos;
      const theme = this.options.ui?.theme === 'auto' ? 'light' : (this.options.ui?.theme ?? 'light');
      const instance = new Ctor({
        position,
        theme,
        onLoadModel: (id: unknown) => void this.loadModel(String(id)).catch(() => undefined),
        onClearCache: (id: unknown) =>
          void this.clearCache(typeof id === 'string' ? id : undefined).catch(() => undefined),
        getModels: async () => {
          const detailed = await this.listModelsDetailed().catch(() => null);
          const rows = detailed ?? this.listModels().map((m) => ({ ...m, cached: false }));
          return rows.map((m) => ({ id: m.id, label: m.label, sizeMb: m.sizeMB, cached: m.cached }));
        },
        getMemory: async () => {
          const mem = this.getMemory();
          const usage = await this.cache.usage().catch(() => ({ entries: 0, approxBytes: 0 }));
          return {
            usageBytes: usage.approxBytes,
            cachedModels: this.currentModelId ? [this.currentModelId] : [],
            note: `active: ${mem.currentModel ?? '—'}${mem.heapMB !== undefined ? ` · heap ${mem.heapMB} MB` : ''} · gpu ${mem.gpu ? 'ok' : 'n/a'}`,
          };
        },
      });
      instance.mount?.();
      this.widget = instance;
    } catch {
      this.widget = null;
    }
  }

  /**
   * Hangmodul (Whisper STT / SpeechT5 TTS). Lusta példány, csak
   * böngészőben használható. Példa: `await ai.audio.transcribe(blob)`.
   */
  get audio(): AudioModule {
    if (!this._audio) this._audio = new AudioModule({});
    return this._audio;
  }

  private _audio: AudioModule | null = null;

  /** Kényelmi STT: `await engine.transcribe(blob)`. */
  async transcribe(blob: Blob, opts?: TranscribeOptions): Promise<string> {
    return this.audio.transcribe(blob, opts);
  }

  /** Kényelmi TTS: szintézis + lejátszás. */
  async speak(text: string, opts?: SynthesizeOptions): Promise<Blob> {
    const blob = await this.audio.synthesize(text, opts);
    if (blob.size > 0) this.audio.play(blob);
    return blob;
  }

  /**
   * Streaming chat generátorként. Ugyanaz, mint `chat`, de chunk-onként yieldel.
   */
  async *streamChat(
    options: ChatOptions,
  ): AsyncGenerator<string, import('./types.js').ChatResult, unknown> {
    const chunks: string[] = [];
    const result = await this.chat({
      ...options,
      onChunk: (d) => {
        chunks.push(d);
        options.onChunk?.(d);
      },
    });
    for (const c of chunks) yield c;
    return result;
  }
}
