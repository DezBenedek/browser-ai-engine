/**
 * AudioModule: böngészős beszédfelismerés (Whisper) és beszédszintézis (SpeechT5).
 *
 * - `@xenova/transformers` kizárólag metódushíváson belül, dynamic importtal
 *   töltődik: top-level import nincs, így a fájl SSR-ben és a csomag nélkül is
 *   importálható. Telepítés: `npm i @xenova/transformers`.
 * - Minden metódus böngésző-őrt futtat (`typeof window === 'undefined'` →
 *   érthető hiba); kivétel az isSupported(), az sosem dob.
 */

import type { CacheOptions } from '../core/types.js';
import { importTransformers } from '../core/loader.js';

/** Elérhető Whisper-méretek; a kisebbtől a pontosabb felé. */
export type WhisperModelId = 'whisper-tiny' | 'whisper-tiny-en' | 'whisper-base';

const WHISPER_MODEL_IDS: Record<WhisperModelId, string> = {
  'whisper-tiny': 'Xenova/whisper-tiny',
  'whisper-tiny-en': 'Xenova/whisper-tiny.en',
  'whisper-base': 'Xenova/whisper-base',
};

const TTS_MODEL_ID = 'Xenova/speecht5_tts';
/** Alapértelmezett beszélő-embedding a transformers.js dokumentációból. */
const DEFAULT_SPEAKER_EMBEDDINGS_URL =
  'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin';

const TARGET_SAMPLE_RATE = 16000;

export interface TranscribeOptions {
  model?: WhisperModelId;
  language?: string;
  onProgress?: (progress: unknown) => void;
}

export interface SynthesizeOptions {
  /** Beszélő-embedding fájl URL-je (nem preset-név). Alapértelmezett: beépített minta. */
  voice?: string;
  onProgress?: (progress: unknown) => void;
}

export interface AudioSupport {
  stt: boolean;
  tts: boolean;
}

export interface AudioModuleOptions {
  cache?: boolean | CacheOptions;
}

/** A transformers-csomagból ténylegesen használt felület (vö. Engine web-llm mintája). */
interface TransformersModule {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<any>;
}

function assertBrowser(feature: string): void {
  if (typeof window === 'undefined') {
    throw new Error(`AudioModule.${feature}: csak böngészőben fut (nincs window-objektum).`);
  }
}

/** Mono jel átmintavételezése lineáris interpolációval. Tiszta függvény. */
export function resampleMono(input: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input.slice();
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error('resampleMono: érvénytelen mintavételi frekvencia.');
  }
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = input.length / outLength;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
  }
  return out;
}

/** Float32 mono mintákból 16 bites PCM WAV Blob. Tiszta függvény. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('encodeWav: érvénytelen sampleRate.');
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class AudioModule {
  private readonly useCache: boolean;
  /** Betöltött pipeline-ok `feladat::modell` kulcson; újrafelhasználás modellenként egyszer. */
  private readonly pipelines = new Map<string, Promise<any>>();
  /** Lejátszás alatt álló elemek a hozzájuk tartozó object URL-lel. */
  private readonly active = new Map<HTMLAudioElement, string>();

  constructor(opts: AudioModuleOptions = {}) {
    const cache = opts.cache;
    this.useCache = typeof cache === 'boolean' ? cache : (cache?.enabled ?? true);
  }

  /** A transformers csomag lusta betöltése, érthető hibával ha nincs telepítve. */
  private async loadTransformers(): Promise<TransformersModule> {
    const mod = await importTransformers();
    try {
      if (mod.env && this.useCache === false) mod.env.useBrowserCache = false;
    } catch {
      // env-flag best-effort: nem blokkol.
    }
    return mod as unknown as TransformersModule;
  }

  /** Pipeline lusta létrehozása feladatra + modellre, egyszer. */
  private loadPipeline(task: string, model: string, onProgress?: (p: unknown) => void): Promise<any> {
    assertBrowser('pipeline');
    const key = `${task}::${model}`;
    const cached = this.pipelines.get(key);
    if (cached !== undefined && this.useCache) return cached;
    const pending: Promise<any> = this.loadTransformers().then((mod) =>
      mod.pipeline(task, model, {
        quantized: false, // TTS-nél a kvantált súly pontatlanabb; STT-re ártalmatlan.
        ...(onProgress !== undefined ? { progress_callback: onProgress } : {}),
      }),
    );
    pending.catch(() => {
      this.pipelines.delete(key); // Sikertelen töltés nem ragad be a cache-be.
    });
    this.pipelines.set(key, pending);
    return pending;
  }

  /** Blob → 16 kHz-es mono Float32Array dekódolással és átmintavételezéssel. */
  private async decodeTo16kMono(blob: Blob): Promise<Float32Array> {
    const raw = await blob.arrayBuffer();
    const win = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = win.AudioContext ?? win.webkitAudioContext;
    if (Ctor === undefined) {
      throw new Error('AudioModule.transcribe: AudioContext nem elérhető ebben a böngészőben.');
    }
    const ctx = new Ctor();
    try {
      // Másolat: a decodeAudioData leválaszthatja (detach) az átadott puffert.
      const decoded = await ctx.decodeAudioData(raw.slice(0));
      let mono: Float32Array;
      if (decoded.numberOfChannels > 1) {
        // Több csatorna átlaga; a Whisper egy csatornát vár.
        mono = new Float32Array(decoded.getChannelData(0).length);
        for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
          const data = decoded.getChannelData(ch);
          for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0);
        }
        for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) / decoded.numberOfChannels;
      } else {
        mono = decoded.getChannelData(0).slice();
      }
      if (decoded.sampleRate === TARGET_SAMPLE_RATE) return mono;
      if (typeof OfflineAudioContext !== 'undefined') {
        const frames = Math.max(1, Math.ceil((mono.length * TARGET_SAMPLE_RATE) / decoded.sampleRate));
        const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
        const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
        buffer.getChannelData(0).set(mono);
        const src = offline.createBufferSource();
        src.buffer = buffer;
        src.connect(offline.destination);
        src.start(0);
        return (await offline.startRendering()).getChannelData(0).slice();
      }
      return resampleMono(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  /**
   * Beszédfelismerés hang-Blob-ból. Kimenet a felismert szöveg.
   * Hálózati/modellhiba esetén a hibaüzenet tartalmazza a modellnevet.
   */
  async transcribe(blob: Blob, opts: TranscribeOptions = {}): Promise<string> {
    assertBrowser('transcribe');
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new Error('AudioModule.transcribe: üres vagy érvénytelen Blob.');
    }
    const audio = await this.decodeTo16kMono(blob);
    const modelId = WHISPER_MODEL_IDS[opts.model ?? 'whisper-tiny'];
    const transcriber: any = await this.loadPipeline(
      'automatic-speech-recognition',
      modelId,
      opts.onProgress,
    );
    let out: any;
    try {
      out = await transcriber(
        audio,
        opts.language !== undefined ? { language: opts.language } : {},
      );
    } catch (err) {
      throw new Error(
        `AudioModule.transcribe: felismerési hiba (${modelId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof out === 'string') return out;
    if (Array.isArray(out)) {
      return out
        .map((c) => (typeof c === 'string' ? c : String((c as { text?: unknown })?.text ?? '')))
        .join(' ')
        .trim();
    }
    const text = (out as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : String(text ?? '');
  }

  /**
   * Beszédszintézis WAV Blob-ba (SpeechT5 + beépített vocoder).
   * Sikertelen transformers-TTS esetén tartalék a natív SpeechSynthesis:
   * az azonnal kimondja a szöveget, és ÜRES Blob tér vissza (nincs
   * lejátszható/tárolható hanganyag, a beszéd már elhangzott).
   * Ha a natív TTS sem elérhető, az eredeti hibával dob.
   */
  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<Blob> {
    assertBrowser('synthesize');
    if (text.trim() === '') throw new Error('AudioModule.synthesize: üres szöveg.');
    try {
      const synthesizer: any = await this.loadPipeline('text-to-speech', TTS_MODEL_ID, opts.onProgress);
      // A pipeline URL-sztringként is elfogadja a beszélő-embeddinget.
      const out: any = await synthesizer(text, {
        speaker_embeddings: opts.voice ?? DEFAULT_SPEAKER_EMBEDDINGS_URL,
      });
      const audio = out?.audio as Float32Array | undefined;
      const rate = out?.sampling_rate as number | undefined;
      if (!(audio instanceof Float32Array) || !Number.isFinite(rate) || (rate ?? 0) <= 0) {
        throw new Error('váratlan TTS-kimenet (audio/sampling_rate hiányzik).');
      }
      return encodeWav(audio, rate as number);
    } catch (engineErr) {
      const msg = engineErr instanceof Error ? engineErr.message : String(engineErr);
      if (typeof window.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        return new Blob([], { type: 'audio/wav' });
      }
      throw new Error(`AudioModule.synthesize: sem a transformers-TTS, sem a natív SpeechSynthesis nem elérhető. ${msg}`);
    }
  }

  /** Blob lejátszása új audio elemen; a visszaadott elem vezérelhető. */
  play(blob: Blob): HTMLAudioElement {
    assertBrowser('play');
    if (!(blob instanceof Blob)) throw new Error('AudioModule.play: érvénytelen Blob.');
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    this.active.set(el, url);
    const release = (): void => {
      if (this.active.has(el)) {
        this.active.delete(el);
        URL.revokeObjectURL(url);
      }
    };
    el.addEventListener('ended', release, { once: true });
    el.addEventListener('error', release, { once: true });
    // Autoplay-tiltáskor az elem paused marad; a hívó gesztus után újra play()-elhet.
    void el.play().catch(() => undefined);
    return el;
  }

  /** Minden aktív lejátszás leállítása; visszatér a leállított elemek számával. */
  stopAll(): number {
    if (typeof window === 'undefined') return 0;
    let stopped = 0;
    for (const [el, url] of this.active) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Leállítás best-effort: hibás állapotú elem sem maradhat követetlenül.
      }
      URL.revokeObjectURL(url);
      stopped++;
    }
    this.active.clear();
    return stopped;
  }

  /** Képességvizsgálat; sosem dob (SSR-ben mindkettő false). */
  isSupported(): AudioSupport {
    if (typeof window === 'undefined') return { stt: false, tts: false };
    const win = window as unknown as Record<string, unknown>;
    const hasAudioContext =
      typeof win['AudioContext'] === 'function' || typeof win['webkitAudioContext'] === 'function';
    const hasFetch = typeof fetch === 'function';
    // TTS natív fallbackkel vagy transformers-szel (utóbbi fetch-et igényel).
    return { stt: hasAudioContext && hasFetch, tts: win['speechSynthesis'] !== undefined || hasFetch };
  }
}
