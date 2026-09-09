/**
 * CacheManager: modellfájlok gyorsítótárazása Cache Storage + OPFS alapon.
 *
 * - Függőségmentes, SSR-safe: minden Cache/OPFS elérés guardolt,
 *   hiányzó API esetén kivétel helyett üres / `false` / `null` eredmény.
 * - A `scope` egy Cache Storage névtér (alapértelmezett `browser-ai-engine-v1`).
 * - Nagy súlyfájloknál shardonként hívandó a `prefetchWithProgress`,
 *   nem több GB egyben (memória).
 */

import type { LoadProgress } from './types.js';

/** `usage()` visszatérési alakja. */
export interface CacheUsage {
  entries: number;
  /** Becsült bájt; `navigator.storage.estimate()` hiányában 0. */
  approxBytes: number;
}

/** `prefetchWithProgress` folyamatjelzés (könnyű alak, nem `LoadProgress`). */
export interface PrefetchProgress {
  loadedBytes: number;
  /** 0 = ismeretlen (nincs Content-Length). */
  totalBytes: number;
  /** 0–100; ismeretlen végösszegnél 0 (indeterminate). */
  percent: number;
}

export class CacheManager {
  readonly scope: string;

  constructor(scope = 'browser-ai-engine-v1') {
    this.scope = scope;
  }

  /** Cache Storage elérhető-e ebben a környezetben. */
  private get supported(): boolean {
    return typeof caches !== 'undefined';
  }

  /**
   * Van-e gyorsítótárazott bejegyzés a modellhez.
   * Próba sorrend: pontos `match(modelId)`, majd URL-részlet (`includes`).
   */
  async has(modelId: string): Promise<boolean> {
    if (!this.supported) return false;
    try {
      const cache = await caches.open(this.scope);
      const direct = await cache.match(modelId);
      if (direct) return true;
      const keys = await cache.keys();
      return keys.some((r) => r.url.includes(modelId));
    } catch {
      return false;
    }
  }

  /** A scope-hoz tartozó gyorsítótárazott URL-ek listája. */
  async keys(): Promise<string[]> {
    if (!this.supported) return [];
    try {
      const cache = await caches.open(this.scope);
      const reqs = await cache.keys();
      return reqs.map((r) => r.url);
    } catch {
      return [];
    }
  }

  /**
   * Törlés: `modelId` megadásával csak a rá illeszkedő bejegyzések,
   * nélküle a teljes scope-névtér.
   */
  async clear(modelId?: string): Promise<void> {
    if (!this.supported) return;
    try {
      if (modelId === undefined) {
        await caches.delete(this.scope);
        return;
      }
      const cache = await caches.open(this.scope);
      const reqs = await cache.keys();
      await Promise.all(
        reqs
          .filter((r) => r.url === modelId || r.url.includes(modelId))
          .map((r) => cache.delete(r)),
      );
    } catch {
      // Törlési hiba nem blokkol: cache ürítés best-effort.
    }
  }

  /**
   * Minden saját névtér (`browser-ai-engine` prefix) törlése.
   * Idegen cache-ekhez nem nyúl.
   */
  async clearAll(): Promise<void> {
    if (!this.supported) return;
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('browser-ai-engine'))
          .map((n) => caches.delete(n)),
      );
    } catch {
      // Best-effort, lásd `clear`.
    }
  }

  /** Bejegyzésszám + becsült méret (`storage.estimate`, ha van). */
  async usage(): Promise<CacheUsage> {
    const entries = (await this.keys()).length;
    try {
      const storage = (
        globalThis as unknown as {
          navigator?: { storage?: { estimate?: () => Promise<{ usage?: number }> } };
        }
      ).navigator?.storage;
      const est = await storage?.estimate?.();
      return { entries, approxBytes: est?.usage ?? 0 };
    } catch {
      return { entries, approxBytes: 0 };
    }
  }

  /**
   * URL letöltése folyamatjelzéssel + Cache-be írás.
   *
   * Működés:
   * 1. Cache-találatnál hálózati kérés nélkül visszaadja a tárolt választ.
   * 2. Egyébként `fetch`, a body manuális olvasásával (progress per chunk),
   *    majd a teljes tartalom `cache.put`-ja és visszaadása.
   * 3. `Content-Length` hiányában `totalBytes: 0`, `percent: 0`.
   * 4. Cache API nélkül sima `fetch` (nincs tárolás).
   *
   * @param url Letöltendő erőforrás.
   * @param onProgress Chunkonként hívott jelzés.
   * @param signal Megszakítás (AbortSignal).
   */
  async prefetchWithProgress(
    url: string,
    onProgress?: (p: PrefetchProgress) => void,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!this.supported) {
      return fetch(url, { signal });
    }
    const cache = await caches.open(this.scope);
    const hit = await cache.match(url).catch(() => undefined);
    if (hit) return hit;

    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      // Hibás vagy nem olvasható body: tárolás best-effort klónnal.
      if (res.ok) {
        await cache.put(url, res.clone()).catch(() => undefined);
      }
      return res;
    }

    const total = Number(res.headers.get('content-length') ?? 0) || 0;
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({
          loadedBytes: loaded,
          totalBytes: total,
          percent: total > 0 ? Math.min(99, (loaded / total) * 100) : 0,
        });
      }
    }
    const blob = new Blob(chunks as BlobPart[], { type: contentType });
    const stored = new Response(blob, {
      headers: { 'content-type': contentType },
    });
    await cache.put(url, stored.clone()).catch(() => undefined);
    onProgress?.({
      loadedBytes: loaded,
      totalBytes: total > 0 ? total : loaded,
      percent: 100,
    });
    return stored;
  }

  /**
   * Perzisztens tároló kérése (`navigator.storage.persist`).
   * @returns `true` ha megadva, különben `false`. Sosem dob.
   */
  async tryOpfsPersist(): Promise<boolean> {
    try {
      const storage = (
        globalThis as unknown as {
          navigator?: { storage?: { persist?: () => Promise<boolean> } };
        }
      ).navigator?.storage;
      if (!storage?.persist) return false;
      return await storage.persist();
    } catch {
      return false;
    }
  }

  /**
   * OPFS gyökérkönyvtár, ha elérhető.
   * @returns A könyvtár-handle vagy `null`. Sosem dob.
   */
  async opfsDir(): Promise<FileSystemDirectoryHandle | null> {
    try {
      const storage = (
        globalThis as unknown as {
          navigator?: { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
        }
      ).navigator?.storage;
      if (!storage?.getDirectory) return null;
      return await storage.getDirectory();
    } catch {
      return null;
    }
  }
}

/** Típusexport a `LoadProgress` újrafelhasználásához prefetch rétegben. */
export type { LoadProgress };
