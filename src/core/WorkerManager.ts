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

import type { WorkerRequest, WorkerResponse } from './types.js';

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
