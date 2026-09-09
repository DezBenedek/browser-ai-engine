// src/worker/inference.worker.ts
// Web Worker belépési pont WebLLM következtetéshez. Külön bundle-be kerül
// (worker entry), fő szálról TILOS statikusan importálni.
// Protokoll:
//   kérés:  { id, type: "load" | "chat" | "unload" | "status", payload }
//   válasz: { id, type: "result" | "chunk" | "error", data?, error? }
// Progress és tokenek egyaránt "chunk"-ként érkeznek, `data.kind` alapján
// ("progress" | "token") különböztethetők meg. Minden kérésre pontosan egy
// "result" vagy "error" a terminális válasz.

export type WorkerRequestType = "load" | "chat" | "unload" | "status";
export type WorkerResponseType = "result" | "chunk" | "error";

export interface WorkerRequest<P = unknown> {
  id: string | number;
  type: WorkerRequestType;
  payload?: P;
}

export interface WorkerResponse<D = unknown> {
  id: string | number;
  type: WorkerResponseType;
  data?: D;
  error?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LoadPayload {
  modelId: string;
  /** Továbbítva a CreateMLCEngine második argumentumába. */
  engineOptions?: Record<string, unknown>;
}

export interface ChatPayload {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  tool_choice?: unknown;
  responseFormat?: { type: string };
}

export type ProgressChunk = { kind: "progress"; progress: number; text: string };
export type TokenChunk = { kind: "token"; delta: string };
/** Chat-végeredmény: ChatResult-kompatibilis (`toolCalls` mindig tömb). */
export type DoneData = {
  kind: "done";
  text: string;
  modelId: string;
  toolCalls: Array<{ name: string; arguments: unknown; id?: string }>;
  usage?: { promptTokens?: number; completionTokens?: number };
};
export type StatusData = { loaded: boolean; modelId: string | null };

/** Minimális strukturális típus a WebLLM motorról, statikus függőség nélkül. */
interface EngineLike {
  chat: {
    completions: {
      create(args: Record<string, unknown>): AsyncIterable<{
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              index?: number;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
  unload?(): Promise<void> | void;
}

interface CreateEngineFn {
  (
    modelId: string,
    options?: Record<string, unknown>,
  ): Promise<EngineLike>;
}

import { importWebLLM } from "../core/loader.js";
import { extractJson } from "../modules/ToolModule.js";

let engine: EngineLike | null = null;
let loadedModelId: string | null = null;

interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

function getScope(): WorkerScope | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as Record<string, unknown>;
  // document hiánya különbözteti meg a workert a fő száltól.
  if (typeof document !== "undefined" || typeof g.postMessage !== "function") {
    return null;
  }
  return globalThis as unknown as WorkerScope;
}

function reply(id: string | number, type: WorkerResponseType, extra?: Partial<WorkerResponse>): void {
  getScope()?.postMessage({ id, type, ok: type !== "error", ...extra });
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleLoad(id: string | number, payload?: LoadPayload): Promise<void> {
  if (!payload?.modelId) {
    reply(id, "error", { error: "load: hiányzó payload.modelId" });
    return;
  }
  // Dinamikus import: bare bundlerben/Node-ban, sima worker-környezetben CDN.
  // (Az IIFE bundle-be a tsup úgyis becsomagolja, így ez ritkán fut le.)
  const wllm = await importWebLLM();
  const CreateMLCEngine = wllm.CreateMLCEngine as CreateEngineFn;
  if (engine) {
    await engine.unload?.();
    engine = null;
    loadedModelId = null;
  }
  engine = await CreateMLCEngine(payload.modelId, {
    ...payload.engineOptions,
    logLevel: "WARN",
    initProgressCallback: (p: { progress: number; text: string }) => {
      const chunk: ProgressChunk = { kind: "progress", progress: p.progress, text: p.text };
      reply(id, "chunk", { data: chunk });
    },
  });
  loadedModelId = payload.modelId;
  const done: DoneData = { kind: "done", text: "", toolCalls: [], modelId: payload.modelId };
  reply(id, "result", { data: done });
}

function safeParseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function handleChat(id: string | number, payload?: ChatPayload): Promise<void> {
  if (!engine) {
    reply(id, "error", { error: "chat: nincs betöltött modell (load szükséges)" });
    return;
  }
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    reply(id, "error", { error: "chat: hiányzó vagy üres payload.messages" });
    return;
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const body: Record<string, unknown> = {
    messages: payload.messages,
    stream: true,
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.maxTokens !== undefined ? { max_tokens: payload.maxTokens } : {}),
    ...(payload.topP !== undefined ? { top_p: payload.topP } : {}),
  };
  if (tools.length > 0) {
    body["tools"] = tools;
    if (payload.tool_choice !== undefined && payload.tool_choice !== "none") {
      body["tool_choice"] = payload.tool_choice;
    }
  }
  if (payload.responseFormat?.type === "json_object") {
    body["response_format"] = { type: "json_object" };
  }
  let stream: AsyncIterable<{
    choices?: Array<{
      delta?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          index?: number;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
  try {
    stream = await engine.chat.completions.create(body);
  } catch (err) {
    // A modell elutasítja a `tools`-t: újra tisztán, prompt-fallback az Engine-ben.
    if (tools.length === 0) throw err;
    const retry = { ...body };
    delete retry["tools"];
    delete retry["tool_choice"];
    stream = await engine.chat.completions.create(retry);
  }
  let text = "";
  const toolArgBuffers = new Map<number, { id?: string; name?: string; args: string }>();
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  for await (const part of stream) {
    const delta = part?.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      text += delta;
      const chunk: TokenChunk = { kind: "token", delta };
      reply(id, "chunk", { data: chunk });
    }
    for (const tc of part?.choices?.[0]?.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      let slot = toolArgBuffers.get(idx);
      if (!slot) {
        slot = { args: "" };
        toolArgBuffers.set(idx, slot);
      }
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (part.usage) {
      promptTokens = part.usage.prompt_tokens;
      completionTokens = part.usage.completion_tokens;
    }
  }
  const toolCalls: DoneData["toolCalls"] = [];
  for (const slot of toolArgBuffers.values()) {
    if (slot.name) {
      toolCalls.push({
        name: slot.name,
        arguments: safeParseArgs(slot.args),
        ...(slot.id ? { id: slot.id } : {}),
      });
    }
  }
  // Fallback: nincs natív hívás, de a szöveg JSON-t rejt.
  if (tools.length > 0 && toolCalls.length === 0) {
    const known = new Set(
      tools.map((t) => t.function?.name).filter((n): n is string => typeof n === "string"),
    );
    try {
      const parsed = extractJson(text) as { name?: unknown; arguments?: unknown } | null;
      if (parsed && typeof parsed.name === "string" && known.has(parsed.name)) {
        toolCalls.push({ name: parsed.name, arguments: parsed.arguments ?? {} });
      }
    } catch {
      // Nem JSON: nincs kinyerhető hívás.
    }
  }
  const done: DoneData = {
    kind: "done",
    text,
    toolCalls,
    usage: { promptTokens, completionTokens },
    modelId: loadedModelId ?? "",
  };
  reply(id, "result", { data: done });
}

async function handleUnload(id: string | number): Promise<void> {
  await engine?.unload?.();
  engine = null;
  loadedModelId = null;
  reply(id, "result", { data: { unloaded: true } });
}

function handleStatus(id: string | number): void {
  const data: StatusData = { loaded: engine !== null, modelId: loadedModelId };
  reply(id, "result", { data });
}

// Csak worker-környezetben regisztrál; fő szálon az import hatástalan.
const scope = getScope();
if (scope) {
  scope.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as WorkerRequest | null | undefined;
    if (!msg || typeof msg !== "object" || (typeof msg.id !== "string" && typeof msg.id !== "number")) {
      return; // Korrelálatlan üzenet: nincs kinek válaszolni.
    }
    const { id, type, payload } = msg;
    // Minden üzenet saját try/catch-ben: egy hiba nem döntheti be a workert.
    (async () => {
      switch (type) {
        case "load":
          await handleLoad(id, payload as LoadPayload | undefined);
          break;
        case "chat":
          await handleChat(id, payload as ChatPayload | undefined);
          break;
        case "unload":
          await handleUnload(id);
          break;
        case "status":
          handleStatus(id);
          break;
        default:
          reply(id, "error", { error: `ismeretlen üzenettípus: ${String(type)}` });
      }
    })().catch((err: unknown) => {
      reply(id, "error", { error: toErrorMessage(err) });
    });
  };
}
