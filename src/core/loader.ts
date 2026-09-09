/**
 * loader: nehéz AI-függőségek lusta betöltése több környezetben.
 *
 * Probléma: a csomag `import('@mlc-ai/web-llm')` / `import('@xenova/transformers')`
 * bare specifikálókat használ. Ez bundlerrel (Vite/Webpack) és Node-ban működik,
 * de sima böngészőben (pl. `<script type="module">` + importmap nélkül) a
 * `Failed to resolve module specifier` hibával elhasal — ilyenkor a modell-
 * letöltés "mintha nem menne".
 *
 * Megoldás: először a bare import (bundler/Node/importmap), ha az elbukik és
 * nem Node-ban vagyunk, visszaesés rögzített verziójú esm.sh CDN URL-re.
 * A bare importon szándékosan NINCS `@vite-ignore`, hogy a bundlerek továbbra
 * is be tudják csomagolni; csak a CDN-URL-es ágon van (ott ártalmatlan).
 */

/** A csomaghoz tesztelt, rögzített verziók (lásd package.json). */
export const WEBLLM_VERSION = '0.2.85';
export const TRANSFORMERS_VERSION = '2.17.2';

export const WEBLLM_CDN_URL = `https://esm.sh/@mlc-ai/web-llm@${WEBLLM_VERSION}`;
export const TRANSFORMERS_CDN_URL = `https://esm.sh/@xenova/transformers@${TRANSFORMERS_VERSION}`;

/** WebLLM-ből ténylegesen használt felület (verziófüggetlen, strukturális). */
export interface WebLLMModuleLike {
  CreateMLCEngine: (
    model: string,
    config?: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** transformers.js-ből ténylegesen használt felület. */
export interface TransformersModuleLike {
  pipeline: (
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  env?: {
    useBrowserCache?: boolean;
    allowLocalModels?: boolean;
  };
}

function isNode(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      (process as { versions?: { node?: string } }).versions?.node !== undefined
    );
  } catch {
    return false;
  }
}

/** Dinamikus import tetszőleges URL-ről (bundlerek nem nyúlnak hozzá). */
function importFromUrl<T>(url: string): Promise<T> {
  const target: string = url;
  return import(/* @vite-ignore */ target) as Promise<T>;
}

// A bare importok SZÁNDÉKOSAN literálok (nem paraméter): így a bundlerek
// (tsup/esbuild/Vite) statikusan látják és be tudják csomagolni őket —
// a worker IIFE bundle pont ettől lesz önálló. Paraméterezett
// `import(változó)` esetén külső futásidejű import maradna.

async function importBareWebLLM(): Promise<WebLLMModuleLike> {
  return (await import('@mlc-ai/web-llm')) as WebLLMModuleLike;
}

async function importBareTransformers(): Promise<TransformersModuleLike> {
  return (await import('@xenova/transformers')) as TransformersModuleLike;
}

async function loadWithCdnFallback<T>(
  bare: () => Promise<T>,
  cdnUrl: string,
  label: string,
): Promise<T> {
  try {
    return await bare();
  } catch (bareErr) {
    if (isNode()) throw bareErr;
    try {
      return await importFromUrl<T>(cdnUrl);
    } catch {
      const detail = bareErr instanceof Error ? bareErr.message : String(bareErr);
      throw new Error(
        `${label} nem tölthető be. Bare import hiba (${detail}); ` +
          `CDN visszaesés (${cdnUrl}) is sikertelen. ` +
          'Bundlerben ellenőrizd a függőséget, sima böngészőben adj hozzá importmap-et ' +
          'vagy engedélyezd a hálózati hozzáférést az esm.sh-hoz.',
      );
    }
  }
}

/** WebLLM betöltése (chat modellekhez). */
export function importWebLLM(): Promise<WebLLMModuleLike> {
  return loadWithCdnFallback(importBareWebLLM, WEBLLM_CDN_URL, 'WebLLM');
}

/** transformers.js betöltése (STT/TTS/embedding/vision pipeline-okhoz). */
export function importTransformers(): Promise<TransformersModuleLike> {
  return loadWithCdnFallback(importBareTransformers, TRANSFORMERS_CDN_URL, 'transformers.js');
}
