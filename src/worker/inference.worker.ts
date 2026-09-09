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
}

export type ProgressChunk = { kind: "progress"; progress: number; text: string };
export type TokenChunk = { kind: "token"; delta: string };
export type DoneData = { kind: "done"; text: string; modelId: string };
export type StatusData = { loaded: boolean; modelId: string | null };

/** Minimális strukturális típus a WebLLM motorról, statikus függőség nélkül. */
interface EngineLike {
  chat: {
    completions: {
      create(args: Record<string, unknown>): AsyncIterable<{
        choices?: Array<{ delta?: { content?: string } }>;
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
  // Dinamikus import: a @mlc-ai/web-llm csak a worker bundle-be kerül.
  const wllm = (await import("@mlc-ai/web-llm")) as unknown as {
    CreateMLCEngine: CreateEngineFn;
  };
  if (engine) {
    await engine.unload?.();
    engine = null;
    loadedModelId = null;
  }
  engine = await wllm.CreateMLCEngine(payload.modelId, {
    ...payload.engineOptions,
    logLevel: "WARN",
    initProgressCallback: (p: { progress: number; text: string }) => {
      const chunk: ProgressChunk = { kind: "progress", progress: p.progress, text: p.text };
      reply(id, "chunk", { data: chunk });
    },
  });
  loadedModelId = payload.modelId;
  const done: DoneData = { kind: "done", text: "", modelId: payload.modelId };
  reply(id, "result", { data: done });
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
  const stream = await engine.chat.completions.create({
    messages: payload.messages,
    stream: true,
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.maxTokens !== undefined ? { max_tokens: payload.maxTokens } : {}),
  });
  let text = "";
  for await (const part of stream) {
    const delta = part?.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      text += delta;
      const chunk: TokenChunk = { kind: "token", delta };
      reply(id, "chunk", { data: chunk });
    }
  }
  const done: DoneData = { kind: "done", text, modelId: loadedModelId ?? "" };
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
