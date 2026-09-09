/**
 * ToolModule: JSON-alapú tool-hívás kinyerése szabad szövegből, minimális
 * JSON-schema ellenőrzés és biztonságos végrehajtás.
 *
 * Külső függőség nincs (zod sem): böngészőben, bundler nélkül is fut.
 * Az Engine két úton éri el az `extractJson`-t (név szerinti export vagy
 * statikus tag), ezért a segédfüggvények statikusként is fenn vannak az osztályon.
 */

import type { ChatToolCall, ToolChoiceOption, ToolDefinition } from '../core/types.js';

/** Végrehajtható tool-hívás: megegyezik a core ChatToolCall alakjával. */
export type ToolCall = ChatToolCall;

/** Handler: tetszőleges szinkron/aszinkron függvény. */
export type ToolHandler = (args: unknown) => unknown | Promise<unknown>;

/** Egy végrehajtott hívás eredménye; hiba dobás helyett `result.error`. */
export interface ToolResult {
  name: string;
  result: unknown;
}

/** Schema-ellenőrzés kimenete. */
export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

/** A validateArgs által értett JSON-schema részhalmaz. */
export interface JsonObjectSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; [option: string]: unknown }>;
  [option: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Tool-leírások + elvárt JSON formátum egyben. Natív tool-támogatás nélküli
 * motornál a rendszerpromptba injektálandó szöveg.
 */
export function buildFunctionPrompt(tools: ToolDefinition[]): string {
  const lines: string[] = [
    'Tool-használat: ha a kérés tool-hívást igényel, egyetlen ```json tool_call blokkal válaszolj; máskor sima szöveggel.',
    '',
    'Toolok:',
  ];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
    lines.push(`  Paraméter JSON-schema: ${JSON.stringify(tool.parameters)}`);
  }
  lines.push(
    '',
    'Példa:',
    '```json tool_call',
    JSON.stringify({ name: tools[0]?.name ?? '<tool-név>', arguments: {} }),
    '```',
  );
  return lines.join('\n');
}

function tryParse(candidate: string): { parsed: boolean; value?: unknown } {
  try {
    return { parsed: true, value: JSON.parse(candidate) as unknown };
  } catch {
    return { parsed: false };
  }
}

/**
 * Első kiegyensúlyozott `{...}` vagy `[...]` szakasz `from` pozíciótól.
 * Sztringen belüli zárójeleket figyelmen kívül hagy; lezáratlanra null.
 */
function balancedSlice(text: string, from: number): string | null {
  const open = text[from];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (close === null) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Jelölt JSON-szakaszok szövegsorrendben. */
function* candidateSlices(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      i++;
      continue;
    }
    const slice = balancedSlice(text, i);
    if (slice === null) {
      i++;
      continue;
    }
    yield slice;
    i += slice.length;
  }
}

const FENCE_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;

/**
 * Első parse-olható JSON a szövegből: először ```json blokkok, aztán
 * kiegyensúlyozott `{...}` / `[...]` keresés. Sikertelenségre dob.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('extractJson: üres bemenet, nincs mit parse-olni.');
  }
  FENCE_RE.lastIndex = 0;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (inner !== '') fences.push(inner);
  }
  for (const inner of fences) {
    const direct = tryParse(inner);
    if (direct.parsed) return direct.value;
    for (const slice of candidateSlices(inner)) {
      const r = tryParse(slice);
      if (r.parsed) return r.value;
    }
  }
  let tried = 0;
  for (const slice of candidateSlices(text)) {
    tried++;
    const r = tryParse(slice);
    if (r.parsed) return r.value;
  }
  if (fences.length > 0 || tried > 0) {
    throw new Error('extractJson: van JSON-jelölt, de egyik sem parse-olható.');
  }
  throw new Error('extractJson: nincs JSON a szövegben (```json blokk vagy {...} sem).');
}

/** Egy nyers hívás-objektum normalizálása + névvalidálás a tool-lista ellen. */
function toToolCall(item: unknown, tools: ToolDefinition[]): ToolCall {
  // OpenAI-alak: { function: { name, arguments } }.
  let node: unknown = item;
  if (isRecord(node) && isRecord(node['function'])) node = node['function'];
  if (!isRecord(node) || typeof node['name'] !== 'string') {
    throw new Error('extractToolCalls: a hívásnak {"name","arguments"} alakúnak kell lennie.');
  }
  const name = node['name'] as string;
  if (!tools.some((t) => t.name === name)) {
    const known = tools.map((t) => `"${t.name}"`).join(', ') || '(üres tool-lista)';
    throw new Error(`extractToolCalls: ismeretlen tool "${name}", várt: ${known}.`);
  }
  let args: unknown = hasOwn(node, 'arguments') ? node['arguments'] : {};
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed !== '') {
      try {
        args = JSON.parse(trimmed) as unknown;
      } catch {
        // Tört JSON-sztring: nyers formában marad, a handler dönthet.
      }
    }
  }
  return args === undefined ? { name, arguments: {} } : { name, arguments: args };
}

/**
 * Tool-hívások kinyerése modellszövegből.
 * - `{"name","arguments"}` (vagy `[{...}]`, `{tool_calls:[...]}`) → közvetlen parse.
 * - Csupasz argumentum-JSON csak megadott toolChoice-szal csomagolható
 *   (`{ name }` alak vagy 'auto'/'none' esetén dob).
 */
export function extractToolCalls(
  text: string,
  tools: ToolDefinition[],
  toolChoice?: ToolChoiceOption,
): ToolCall[] {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    throw new Error(`extractToolCalls: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error('extractToolCalls: üres híváslista.');
    return parsed.map((item) => toToolCall(item, tools));
  }
  if (isRecord(parsed) && Array.isArray(parsed['tool_calls'])) {
    const list = parsed['tool_calls'] as unknown[];
    if (list.length === 0) throw new Error('extractToolCalls: üres tool_calls lista.');
    return list.map((item) => toToolCall(item, tools));
  }
  if (isRecord(parsed) && typeof parsed['name'] === 'string') {
    return [toToolCall(parsed, tools)];
  }
  if (isRecord(parsed)) {
    if (toolChoice !== undefined && typeof toolChoice === 'object') {
      if (!tools.some((t) => t.name === toolChoice.name)) {
        throw new Error(`extractToolCalls: toolChoice "${toolChoice.name}" nincs a tool-listában.`);
      }
      return [{ name: toolChoice.name, arguments: parsed }];
    }
    throw new Error(
      'extractToolCalls: a JSON nem tartalmaz "name" mezőt; ' +
        'válaszolj {"name","arguments"} alakban vagy adj meg toolChoice-t.',
    );
  }
  throw new Error('extractToolCalls: váratlan JSON-alak (objektum vagy lista várt).');
}

function typeMatches(declared: string, value: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return true; // Ismeretlen típus nem blokkol (előre kompatibilis).
  }
}

/**
 * Minimális JSON-schema ellenőrzés zod nélkül: object-típus, required mezők,
 * properties-típusok (string/number/integer/boolean/array/object/null).
 */
export function validateArgs(
  schema: JsonObjectSchema | null | undefined,
  args: unknown,
): ValidationResult {
  const errors: string[] = [];
  if (schema === null || schema === undefined || Object.keys(schema).length === 0) {
    return { ok: true };
  }
  const type = typeof schema.type === 'string' ? schema.type : 'object';
  if (type !== 'object') {
    return typeMatches(type, args) ? { ok: true } : { ok: false, errors: [`args várt típusa: ${type}`] };
  }
  if (!isRecord(args)) return { ok: false, errors: ['args nem objektum'] };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === 'string')
    : [];
  for (const key of required) {
    if (!hasOwn(args, key) || args[key] === undefined) {
      errors.push(`hiányzó kötelező mező: "${key}"`);
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, prop] of Object.entries(properties)) {
    if (!hasOwn(args, key) || args[key] === undefined) continue;
    const declared = isRecord(prop) && typeof prop['type'] === 'string' ? prop['type'] : undefined;
    if (declared !== undefined && !typeMatches(declared, args[key])) {
      errors.push(`"${key}" várt típusa: ${declared}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Hívások végrehajtása sorban. Egyedi hiba nem dobódik: az adott hívás
 * `result.error` sztringgel tér vissza, a többi lefut.
 */
export async function dispatch(
  toolCalls: ToolCall[],
  handlers: Record<string, ToolHandler>,
): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const call of toolCalls) {
    const handler = handlers[call.name];
    if (handler === undefined) {
      out.push({ name: call.name, result: { error: `ismeretlen tool: "${call.name}"` } });
      continue;
    }
    try {
      out.push({ name: call.name, result: await handler(call.arguments) });
    } catch (err) {
      out.push({ name: call.name, result: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return out;
}

export class ToolModule {
  // Statikus elérés az Engine dinamikus importjához (`mod.ToolModule.extractJson`).
  static readonly extractJson = extractJson;
  static readonly extractToolCalls = extractToolCalls;
  static readonly validateArgs = validateArgs;
  static readonly dispatch = dispatch;
  static readonly buildFunctionPrompt = buildFunctionPrompt;

  buildPrompt(tools: ToolDefinition[]): string {
    return buildFunctionPrompt(tools);
  }

  extractCalls(text: string, tools: ToolDefinition[], toolChoice?: ToolChoiceOption): ToolCall[] {
    return extractToolCalls(text, tools, toolChoice);
  }

  validate(schema: JsonObjectSchema | null | undefined, args: unknown): ValidationResult {
    return validateArgs(schema, args);
  }

  run(calls: ToolCall[], handlers: Record<string, ToolHandler>): Promise<ToolResult[]> {
    return dispatch(calls, handlers);
  }
}
