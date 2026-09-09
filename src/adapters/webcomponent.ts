/**
 * Web Component adapter: `<browser-ai-chat>` egyedi elem.
 *
 * - Keretrendszer-független: működik Vanilla, React, Vue, Svelte, Angular,
 *   Solid vagy plain HTML oldalban egyaránt.
 * - Shadow DOM-ba zárt mini chat-UI (státusz, napló, input, Load/Send gombok).
 * - Az Engine lusta: az első Load-kattintásra példányosodik, csak böngészőben.
 * - Regisztrálás: `defineBrowserAIElements()` (idempotens, SSR-safe no-op).
 *
 * ```html
 * <script type="module">
 *   import { defineBrowserAIElements } from 'browser-ai-engine/webcomponent';
 *   defineBrowserAIElements();
 * </script>
 * <browser-ai-chat model="qwen-2.5-0.5b" theme="dark"></browser-ai-chat>
 * ```
 */

import type { BrowserAIEngine } from '../core/Engine.js';
import type { ChatMessage } from '../core/types.js';

const TAG = 'browser-ai-chat';

type Theme = 'light' | 'dark';

const CSS = [
  ':host{display:block;max-width:640px;font:14px/1.5 system-ui,sans-serif;',
  '--bae-bg:#fff;--bae-fg:#1a1d21;--bae-muted:#5f6570;--bae-border:#e2e5ea;--bae-accent:#2563eb;}',
  ':host([theme="dark"]){--bae-bg:#16191f;--bae-fg:#e8eaf0;--bae-muted:#9aa1ad;',
  '--bae-border:#2e3440;--bae-accent:#4f8cff;}',
  '.wrap{border:1px solid var(--bae-border);border-radius:12px;background:var(--bae-bg);color:var(--bae-fg);overflow:hidden}',
  '.status{padding:8px 12px;font-size:12px;color:var(--bae-muted);border-bottom:1px solid var(--bae-border)}',
  '.log{padding:12px;min-height:120px;max-height:320px;overflow-y:auto;white-space:pre-wrap}',
  '.row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--bae-border)}',
  'input{flex:1;font:inherit;padding:8px;border:1px solid var(--bae-border);border-radius:8px;background:var(--bae-bg);color:var(--bae-fg)}',
  'button{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;cursor:pointer;',
  'border:1px solid var(--bae-border);background:var(--bae-bg);color:var(--bae-fg)}',
  'button.primary{background:var(--bae-accent);border-color:var(--bae-accent);color:#fff}',
].join('\n');

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  );
}

export class BrowserAIChatElement extends HTMLElement {
  private engine: BrowserAIEngine | null = null;
  private shadow: ShadowRoot | null = null;
  private logEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  static get observedAttributes(): string[] {
    return ['theme'];
  }

  constructor() {
    super();
    if (typeof ShadowRoot !== 'undefined') {
      this.shadow = this.attachShadow({ mode: 'open' });
    }
  }

  get model(): string {
    return this.getAttribute('model') ?? 'qwen-2.5-0.5b';
  }

  get theme(): Theme {
    return this.getAttribute('theme') === 'dark' ? 'dark' : 'light';
  }

  connectedCallback(): void {
    if (!this.shadow || this.shadow.childElementCount > 0) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = [
      '<div class="status">Idle — press Load (WebGPU required).</div>',
      '<div class="log" aria-live="polite"></div>',
      '<div class="row"><button data-action="load">Load</button>',
      '<input placeholder="Ask something…" aria-label="Message" />',
      '<button data-action="send" class="primary">Send</button></div>',
    ].join('');
    this.shadow.append(style, wrap);
    this.statusEl = wrap.querySelector('.status');
    this.logEl = wrap.querySelector('.log');
    this.inputEl = wrap.querySelector('input');
    wrap.addEventListener('click', (ev) => void this.handleClick(ev));
    this.inputEl?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this.send();
    });
  }

  attributeChangedCallback(name: string): void {
    if (name === 'theme') {
      // A :host([theme]) szelektor magától követi az attribútumot.
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private appendLog(who: string, text: string): void {
    if (!this.logEl) return;
    const div = document.createElement('div');
    div.innerHTML = `<strong>${esc(who)}:</strong> ${esc(text)}`;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private async ensureEngine(): Promise<BrowserAIEngine> {
    if (!this.engine) {
      const mod = await import('../core/Engine.js');
      this.engine = new mod.BrowserAIEngine({ ui: { enabled: false } });
    }
    return this.engine;
  }

  private handleClick(ev: Event): void {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest('[data-action]') : null;
    if (!(btn instanceof HTMLElement)) return;
    if (btn.dataset.action === 'load') void this.load();
    else if (btn.dataset.action === 'send') void this.send();
  }

  /** Modell betöltése a `model` attribútum alapján. */
  async load(): Promise<void> {
    try {
      const engine = await this.ensureEngine();
      this.setStatus('Loading…');
      await engine.loadModel(this.model, (p) => {
        this.setStatus(`Loading… ${p.percent}% — ${p.mbPerSec} MB/s`);
      });
      this.setStatus(`Ready (${this.model}).`);
    } catch (err) {
      this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Aktuális input elküldése. */
  async send(): Promise<void> {
    const q = this.inputEl?.value.trim() ?? '';
    if (!q) return;
    if (this.inputEl) this.inputEl.value = '';
    this.appendLog('you', q);
    try {
      const engine = await this.ensureEngine();
      const messages: ChatMessage[] = [{ role: 'user', content: q }];
      const result = await engine.chat({
        messages,
        onChunk: (d) => this.setStatus(`Streaming… ${d.slice(0, 60)}`),
      });
      this.appendLog('ai', result.text);
      this.setStatus(`Ready (${this.model}).`);
    } catch (err) {
      this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * `<browser-ai-chat>` regisztrálása. Ismételt hívásra és SSR-ben no-op.
 */
export function defineBrowserAIElements(tag: string = TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tag)) {
    customElements.define(tag, BrowserAIChatElement);
  }
}
