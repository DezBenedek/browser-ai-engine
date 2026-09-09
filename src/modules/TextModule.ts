/**
 * TextModule: streaming chat-kiegészítés WebLLM motor fölött.
 *
 * - A motor típusa szándékosan `any`: nincs fordítási függés a
 *   `@mlc-ai/web-llm` csomagtól; futásidőben csak a ténylegesen használt
 *   felület (`chat.completions.create`) van elérve.
 * - A tiszta segédfüggvények (`buildToolInstruction`, `collectStream`,
 *   `estimateTokens`) külön is exportáltak, mock nélkül tesztelhetők.
 */

import type { ChatMessage, ToolChoiceOption, ToolDefinition } from '../core/types.js';

/** Üzenet-összeállítási beállítások. */
export interface BuildMessagesOptions {
  tools?: ToolDefinition[];
  responseFormat?: { type: 'json_object' };
  /** Igaz esetén a motor natívan kezeli a tool-hívást: nincs prompt-injektálás. */
  nativeToolSupport?: boolean;
  /** Kényszerített tool; csak az injektált utasítás szövegébe kerül bele. */
  toolChoice?: ToolChoiceOption;
}

/** Streaming chat-hívás paraméterei; ismeretlen kulcsok továbbadódnak a motornak. */
export interface StreamChatCompletionParams {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [option: string]: unknown;
}

/**
 * Tool-leírásokból rendszerutasítás: sémák + elvárt ```json tool_call formátum.
 * Tiszta függvény, a TextModule.buildMessages és a tesztek is ezt használják.
 */
export function buildToolInstruction(tools: ToolDefinition[]): string {
  const lines: string[] = [
    'Tool-hívási szabályok:',
    '- Ha a kérés tool-hívást igényel, a válasz KIZÁRÓLAG egyetlen ```json tool_call blokk legyen, kísérőszöveg nélkül.',
    '- Ha nem kell tool, válaszolj sima szöveggel, kódblokk nélkül.',
    '',
    'Elérhető toolok:',
  ];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
    lines.push(`  Paraméter JSON-schema: ${JSON.stringify(tool.parameters)}`);
  }
  const exampleName = tools[0]?.name ?? '<tool-név>';
  lines.push(
    '',
    'Elvárt formátum tool-híváskor:',
    '```json tool_call',
    JSON.stringify({ name: exampleName, arguments: {} }, null, 2),
    '```',
  );
  return lines.join('\n');
}

/** Durva tokenbecslés (~4 karakter/token); kvóta- és kontextusfigyeléshez elég. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Streamelt darabok összefűzése egyetlen szöveggé. */
export async function collectStream(
  stream: AsyncIterable<string>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    onChunk?.(chunk);
  }
  return text;
}

export class TextModule {
  /** Motor-hozzáférés injektálva; null hívásidőben derül ki, nem konstrukciókor. */
  private readonly getEngine: () => any;

  constructor(getEngine: () => any) {
    this.getEngine = getEngine;
  }

  /**
   * Üzenetek előkészítése. Ha van tool, de nincs natív támogatás, a tool-leírást
   * rendszerüzenetbe injektálja (meglévő system üzenet végére fűzve).
   * A bemeneti tömböt nem módosítja.
   */
  buildMessages(messages: ChatMessage[], opts: BuildMessagesOptions = {}): ChatMessage[] {
    void opts.responseFormat; // A natív ág dolga; a prompt-összeállítás nem használja.
    const tools = opts.tools ?? [];
    if (tools.length === 0 || opts.nativeToolSupport === true) return [...messages];
    let instruction = buildToolInstruction(tools);
    const choice = opts.toolChoice;
    if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
      instruction += `\nElvárt tool: "${choice.name}".`;
    }
    const [first, ...rest] = messages;
    if (first !== undefined && first.role === 'system') {
      return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest];
    }
    return [{ role: 'system', content: instruction }, ...messages];
  }

  /**
   * `engine.chat.completions.create({ stream: true })` wrapper.
   * A delta-content darabokat yieldeli; üres/nem-szöveg darabokat eldob.
   */
  async *streamChatCompletion(
    params: StreamChatCompletionParams,
  ): AsyncGenerator<string, void, unknown> {
    const engine: any = this.getEngine();
    if (engine === null || engine === undefined) {
      throw new Error('TextModule.streamChatCompletion: nincs motor (getEngine() null/undefined).');
    }
    const stream = await engine.chat.completions.create({ ...params, stream: true });
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (typeof chunk === 'string') {
        if (chunk.length > 0) yield chunk;
        continue;
      }
      const delta = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]
        ?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) yield delta;
    }
  }

  /** Modulszintű collectStream metódus-alakban. */
  collectStream(stream: AsyncIterable<string>, onChunk?: (chunk: string) => void): Promise<string> {
    return collectStream(stream, onChunk);
  }

  /** Modulszintű estimateTokens metódus-alakban. */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }
}
