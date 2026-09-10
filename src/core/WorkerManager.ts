/**
 * WorkerManager: natív Worker körüli vékony wrapper.
 *
 * - Worker nélkül (CSP tiltás, SSR, `enabled: false`) `ensure()` null-t ad;
 *   ilyenkor a hívó főszálon fut tovább (`call` elutasít `WORKER_DISABLED`
 *   kóddal, amit a hívó lekezel).
 * - `call` kérés/válasz párosítás `id → resolver` térképpel; `chunk`
 *   üzenetek az `onChunk`-nak mennek, `result`/`error` zárja a kérést.
 * - Nincs szivárgás: minden lezárás törli a térképbejegyzést,
 *   az abort-listenert és a timeoutot.
 *
 * Protokoll:
 * - fel:   `postMessage({ id, type, payload })`
 * - le:    `onmessage({ id, type: 'chunk'|'result'|'error', data/error })`
 */

import type { ChatResult, LoadProgress, WorkerRequest, WorkerResponse } from './types.js';

/** `call` kérés azonosító-típusai (a worker felé). */
export type WorkerCallType = WorkerRequest['type'];

/** Streaming részlet callback. */
export type WorkerChunkCallback = (data: unknown) => void;

interface PendingEntry {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onChunk?: WorkerChunkCallback;
  timeoutId: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 10 perc: nagy modell + lassú eszköz esetén is elég. */
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** `call` elutasítási ok worker nélküli üzemben. */
export const WORKER_DISABLED = 'WORKER_DISABLED';

export class WorkerManager {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private seq = 0;

  /**
   * @param getWorkerUrl Worker URL feloldása — csak `ensure()`-ben hívódik,
   *   így `import.meta.url` alapú URL is biztonságos (try/catch védett).
   * @param opts `{ enabled }`: `false` esetén worker sose készül.
   */
  constructor(
    private readonly getWorkerUrl: () => string | URL | null,
    private readonly opts: { enabled: boolean },
  ) {}

  /** Van-e élő worker példány. */
  isActive(): boolean {
    return this.worker !== null;
  }

  /**
   * Worker létrehozása egyszer (idempotens).
   * @returns A worker, vagy `null` ha nem készíthető (kikapcsolt / nincs
   *   `Worker` API / érvénytelen URL).
   */
  ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (this.opts.enabled === false) return null;
    if (typeof Worker === 'undefined') return null;
    let url: string | URL | null = null;
    try {
      url = this.getWorkerUrl();
    } catch {
      return null;
    }
    if (url === null) return null;
    try {
      this.worker = new Worker(url, { type: 'module' });
    } catch {
      this.worker = null;
      return null;
    }
    this.worker.onmessage = (ev: MessageEvent) => this.route(ev.data);
    this.worker.onerror = () => {
      const err = new Error('Worker hiba: lásd konzol / worker oldali log.');
      this.failAll(err);
    };
    return this.worker;
  }

  /**
   * Kérés küldése a workernek.
   * @param type Kérés típusa (`load`|`chat`|`unload`|`status`).
   * @param payload Kérés payload.
   * @param onChunk Streaming részletek fogadása.
   * @param signal Megszakítás: helyi elutasítás + best-effort értesítés.
   * @throws `WORKER_DISABLED` kóddal ha nincs worker (hívó fusson főszálon).
   */
  call<T>(type: WorkerCallType, payload?: unknown, onChunk?: WorkerChunkCallback, signal?: AbortSignal): Promise<T> {
    const worker = this.ensure();
    if (!worker) {
      return Promise.reject(Object.assign(new Error('Worker kikapcsolt vagy nem elérhető; főszálas futás.'), { code: WORKER_DISABLED }));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Megszakítva.'));
    }
    const id = `${Date.now().toString(36)}-${this.seq++}`;
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        detachAbort();
        reject(new Error(`Worker kérés időtúllépés (${type}, 10 perc).`));
      }, CALL_TIMEOUT_MS);

      const detachAbort = (): void => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timeoutId);
        detachAbort();
        // Best-effort értesítés; a worker figyelmen kívül hagyhatja.
        try {
          worker.postMessage({ id, type: '__abort', payload: { ofType: type } });
        } catch {
          // Küldési hiba irreleváns: a hívó már elengedte a kérést.
        }
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Megszakítva.'));
      };

      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        onChunk,
        timeoutId,
        signal,
        onAbort,
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const msg: WorkerRequest = { id, type, payload };
        worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeoutId);
        detachAbort();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Worker leállítása + minden függő kérés elutasítása. */
  terminate(): void {
    try {
      this.worker?.terminate();
    } catch {
      // Dupla terminate / halott worker nem hiba.
    }
    this.worker = null;
    this.failAll(new Error('Worker leállítva.'));
  }

  /** Bejövő worker üzenet elosztása a függő kéréshez. */
  private route(raw: unknown): void {
    const msg = raw as WorkerResponse | null;
    if (!msg || typeof msg.id !== 'string') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return; // Késői / abortált kérés válasza: eldobható.
    if (msg.type === 'chunk') {
      entry.onChunk?.(msg.data);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timeoutId);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    // A worker nem mindig küldi az `ok` mezőt; hiánya sikert jelent
    // `result`-nál, hibát `error`-nál.
    if (msg.type === 'result' && msg.ok !== false) {
      entry.resolve(msg.data as never);
    } else {
      entry.reject(new Error(msg.error || 'Ismeretlen worker hiba.'));
    }
  }

  /** Minden függő kérés elutasítása + takarítás (hiba/leállás esetén). */
  private failAll(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) {
      clearTimeout(e.timeoutId);
      if (e.signal && e.onAbort) e.signal.removeEventListener('abort', e.onAbort);
      e.reject(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker → főszál alak-normalizálás
// ---------------------------------------------------------------------------
// A worker többféle chunk-alakot küldhet (régi/új protokoll); ezek a tiszta
// függvények egységesítik őket, hogy az Engine-nek ne kelljen találgatnia.
// Mind DOM-függőség nélkül tesztelhető.

/** Worker progress chunk: elfogadott alakok. */
export type WorkerProgressChunk =
  | Partial<LoadProgress>
  | { kind: 'progress'; progress: number; text?: string }
  | { progress: number; text?: string };

/**
 * Worker progress chunk → LoadProgress. `sizeMB` a registry-ből jön a
 * bájt-becsléshez. Ismeretlen alakra `null` (eldobandó).
 */
export function normalizeWorkerProgress(
  chunk: unknown,
  modelId: string,
  sizeMB: number,
): LoadProgress | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const c = chunk as Record<string, unknown>;
  if (typeof c['percent'] === 'number') {
    // Nem véges / tartományon kívüli százalék: eldobás, ill. vágás 0–100-ra.
    if (!Number.isFinite(c['percent'])) return null;
    const percent = Math.min(100, Math.max(0, c['percent']));
    const p = c as Partial<LoadProgress>;
    const loadedBytes = finiteNonNegative(p.loadedBytes) ? (p.loadedBytes as number) : 0;
    const totalBytes = finiteNonNegative(p.totalBytes) ? (p.totalBytes as number) : 0;
    return {
      modelId,
      loadedBytes,
      totalBytes,
      percent,
      mbPerSec: finiteNumber(p.mbPerSec) ? (p.mbPerSec as number) : 0,
      etaSec: finiteNonNegative(p.etaSec) ? (p.etaSec as number) : 0,
      status: isLoadStatus(p.status) ? p.status : 'downloading',
    };
  }
  if (typeof c['progress'] === 'number') {
    if (!Number.isFinite(c['progress'])) return null;
    const frac = Math.min(1, Math.max(0, c['progress'] as number));
    const total = Math.round(sizeMB * 1024 * 1024);
    return {
      modelId,
      loadedBytes: Math.round(total * frac),
      totalBytes: total,
      percent: Math.round(frac * 100),
      mbPerSec: 0,
      etaSec: 0,
      status: frac >= 1 ? 'loading' : 'downloading',
    };
  }
  return null;
}

function finiteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function finiteNonNegative(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isLoadStatus(v: unknown): v is LoadProgress['status'] {
  return (
    v === 'downloading' || v === 'cached' || v === 'loading' || v === 'ready' || v === 'error'
  );
}

/** Worker token chunk → szöveg-delta. Ismeretlen alakra üres sztring. */
export function normalizeWorkerToken(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk === 'object') {
    const c = chunk as Record<string, unknown>;
    if (typeof c['delta'] === 'string') return c['delta'] as string;
    if (typeof c['text'] === 'string') return c['text'] as string;
  }
  return '';
}

/**
 * Worker chat-végeredmény → ChatResult. Elfogadja a worker `DoneData`
 * (`{ kind: 'done', text, modelId }`) és a teljes ChatResult alakot is.
 */
export function normalizeWorkerChatResult(data: unknown, modelId: string): ChatResult | null {
  if (!data || typeof data !== 'object') {
    return typeof data === 'string' ? { text: data, toolCalls: [], modelId } : null;
  }
  const d = data as Record<string, unknown>;
  if (typeof d['text'] !== 'string') return null;
  const toolCalls = Array.isArray(d['toolCalls'])
    ? (d['toolCalls'] as ChatResult['toolCalls'])
    : [];
  const usage =
    d['usage'] && typeof d['usage'] === 'object'
      ? (d['usage'] as ChatResult['usage'])
      : undefined;
  return {
    text: d['text'] as string,
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
    modelId: typeof d['modelId'] === 'string' ? (d['modelId'] as string) : modelId,
  };
}
