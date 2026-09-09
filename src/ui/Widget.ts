// src/ui/Widget.ts
// Keretrendszer-független lebegő widget Shadow DOM-mal.
// - Modul szinten semmilyen DOM-mellékhatás: SSR alatt importálható.
// - Minden DOM-hozzáférés `typeof document === "undefined"` guard mögött van.
// - Stílus: beépített DEFAULT_CSS fallback + setCustomCss() felülíráshoz.
//   A teljes téma külön fájlban: src/ui/widget.css (manuális <link>-hez).

export type WidgetPosition = "bottom-right" | "bottom-left";
export type WidgetTheme = "dark" | "light";

export interface WidgetProgress {
  /** 0–100 közötti százalék. */
  percent: number;
  mbPerSec?: number;
  etaSec?: number;
  label?: string;
}

export interface WidgetModelEntry {
  id: string;
  label?: string;
  sizeMb?: number;
  cached?: boolean;
}

export interface WidgetMemoryInfo {
  quotaBytes?: number;
  usageBytes?: number;
  cachedModels?: string[];
  note?: string;
}

export interface WidgetOptions {
  position?: WidgetPosition;
  theme?: WidgetTheme;
  onLoadModel?: (modelId: string) => void | Promise<void>;
  onClearCache?: (modelId?: string) => void | Promise<void>;
  /** Panelnyitáskor hívódik; listája felülírja a kézi setModels() tartalmat. */
  getModels?: () => WidgetModelEntry[] | Promise<WidgetModelEntry[]>;
  getMemory?: () => WidgetMemoryInfo | Promise<WidgetMemoryInfo>;
  onToggle?: (open: boolean) => void;
}

/**
 * Rövid beépített stílus. Szándékosan nem a widget.css másolata:
 * önállóan is használható alap, teljes téma a widget.css-ben van.
 */
export const DEFAULT_CSS = [
  ":host{position:fixed;bottom:20px;z-index:2147483647;font:13px/1.45 system-ui,sans-serif;",
  "--bae-bg:#fff;--bae-fg:#1a1d21;--bae-muted:#5f6570;--bae-border:#e2e5ea;",
  "--bae-accent:#2563eb;--bae-accent-fg:#fff;--bae-soft:#f4f5f7;--bae-track:#e8ebf0;}",
  ':host([data-position="bottom-right"]){right:20px}',
  ':host([data-position="bottom-left"]){left:20px}',
  ':host([data-theme="dark"]){--bae-bg:#16191f;--bae-fg:#e8eaf0;--bae-muted:#9aa1ad;',
  "--bae-border:#2e3440;--bae-accent:#4f8cff;--bae-accent-fg:#0b1220;--bae-soft:#1f232c;--bae-track:#2b313c}",
  ".bae-fab{width:48px;height:48px;border-radius:50%;border:1px solid var(--bae-border);",
  "background:var(--bae-accent);color:var(--bae-accent-fg);font-size:22px;cursor:pointer;margin-left:auto;display:flex;align-items:center;justify-content:center}",
  ".bae-panel{display:none;width:min(360px,calc(100vw - 40px));max-height:min(560px,calc(100dvh - 100px));",
  "overflow-y:auto;margin-bottom:12px;background:var(--bae-bg);color:var(--bae-fg);",
  "border:1px solid var(--bae-border);border-radius:12px}",
  ':host([data-open="true"]) .bae-panel{display:block}',
  ".bae-header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--bae-border);font-weight:650}",
  ".bae-body{padding:10px 12px;display:flex;flex-direction:column;gap:12px}",
  ".bae-status-row,.bae-gpu{font-size:12px;color:var(--bae-muted)}",
  ".bae-progress-track{height:8px;border-radius:999px;background:var(--bae-track);overflow:hidden}",
  ".bae-progress-bar{height:100%;width:0%;background:var(--bae-accent)}",
  ".bae-progress-meta{font-size:12px;color:var(--bae-muted)}",
  ".bae-model-row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--bae-border);border-radius:8px;background:var(--bae-soft)}",
  ".bae-model-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".bae-model-meta{font-size:11px;color:var(--bae-muted);margin-left:auto;white-space:nowrap}",
  ".bae-btn{font:inherit;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;",
  "border:1px solid var(--bae-border);background:var(--bae-bg);color:var(--bae-fg);cursor:pointer;white-space:nowrap}",
  '.bae-btn[data-variant="primary"]{background:var(--bae-accent);border-color:var(--bae-accent);color:var(--bae-accent-fg)}',
  '.bae-btn[data-variant="danger"]{color:#dc2626;border-color:#dc2626}',
  ".bae-memory{font-size:12px;color:var(--bae-muted);background:var(--bae-soft);border:1px solid var(--bae-border);border-radius:8px;padding:8px;white-space:pre-wrap;word-break:break-word}",
  ".bae-footer{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid var(--bae-border)}",
  ".bae-empty{font-size:12px;color:var(--bae-muted)}",
].join("\n");

/** DEFAULT_CSS alias: bundleres `?inline` import kiváltására. */
export const WIDGET_CSS = DEFAULT_CSS;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function fmtBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

function fmtEta(sec?: number): string {
  if (sec === undefined || Number.isNaN(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

const canUseDom = (): boolean => typeof document !== "undefined";

export class FloatingWidget {
  private readonly opts: WidgetOptions;
  private readonly position: WidgetPosition;
  private theme: WidgetTheme;
  private customCss: string | null = null;
  private open = false;

  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private onClickBound: ((ev: Event) => void) | null = null;

  constructor(opts: WidgetOptions = {}) {
    // Konstruktor mellékhatásmentes: DOM-művelet csak mount()-ban.
    this.opts = opts;
    this.position = opts.position ?? "bottom-right";
    this.theme = opts.theme ?? "light";
  }

  get isMounted(): boolean {
    return this.host !== null;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Widget felépítése és beszúrása. SSR alatt és ismételt híváskor no-op. */
  mount(target?: HTMLElement | string): void {
    if (!canUseDom() || this.host) return;
    const doc = document;
    const parent: HTMLElement | null =
      typeof target === "string"
        ? doc.querySelector(target)
        : (target ?? doc.body);
    if (!parent) return;

    const host = doc.createElement("div");
    host.className = "bae-host";
    host.dataset.position = this.position;
    host.dataset.theme = this.theme;
    host.dataset.open = "false";

    const shadow = host.attachShadow({ mode: "open" });

    this.styleEl = doc.createElement("style");
    this.styleEl.textContent = this.customCss ?? DEFAULT_CSS;
    shadow.appendChild(this.styleEl);

    const root = doc.createElement("div");
    root.className = "bae-root";
    root.innerHTML = [
      '<div class="bae-panel" role="dialog" aria-label="Browser AI">',
      '<div class="bae-header"><span class="bae-title">Browser AI</span>',
      '<button class="bae-btn" data-action="close" aria-label="Bezárás">✕</button></div>',
      '<div class="bae-body">',
      '<div class="bae-status-row"><span class="bae-gpu" data-ok=""><span class="bae-gpu-dot"></span><span class="bae-gpu-label">GPU: —</span></span>',
      '<span class="bae-status">Kész.</span></div>',
      '<div class="bae-progress"><div class="bae-progress-track"><div class="bae-progress-bar"></div></div>',
      '<div class="bae-progress-meta">Nincs folyamatban lévő letöltés.</div></div>',
      '<div><div class="bae-section-title">Modellek</div><div class="bae-models"><div class="bae-empty">Nincs modelllista. setModels() vagy getModels().</div></div></div>',
      '<div><div class="bae-section-title">Tárhely</div><div class="bae-memory">—</div></div>',
      "</div>",
      '<div class="bae-footer"><button class="bae-btn" data-action="refresh">Frissítés</button>',
      '<button class="bae-btn" data-variant="danger" data-action="clear-all">Cache törlése</button></div>',
      "</div>",
      '<button class="bae-fab" data-action="toggle" aria-expanded="false" aria-label="Browser AI panel">✦</button>',
    ].join("");
    shadow.appendChild(root);

    this.onClickBound = (ev: Event) => void this.handleClick(ev);
    root.addEventListener("click", this.onClickBound);

    parent.appendChild(host);
    this.host = host;
    this.shadow = shadow;
  }

  /** Eltávolítja a widgetet a DOM-ból, listenerekkel együtt. */
  destroy(): void {
    if (!canUseDom()) {
      this.host = null;
      this.shadow = null;
      return;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
    this.styleEl = null;
    this.onClickBound = null;
    this.open = false;
  }

  /** Egyedi CSS a beépített helyett (pl. widget.css tartalma). */
  setCustomCss(css: string): void {
    this.customCss = css;
    if (this.styleEl) this.styleEl.textContent = css;
  }

  setTheme(theme: WidgetTheme): void {
    this.theme = theme;
    if (this.host) this.host.dataset.theme = theme;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  openPanel(): void {
    this.setOpen(true);
  }

  closePanel(): void {
    this.setOpen(false);
  }

  setStatus(text: string): void {
    const el = this.query(".bae-status");
    if (el) el.textContent = text;
  }

  setGpuStatus(ok: boolean | null, label?: string): void {
    if (!this.shadow) return;
    const wrap = this.shadow.querySelector(".bae-gpu");
    const text = this.shadow.querySelector(".bae-gpu-label");
    if (wrap instanceof HTMLElement) {
      wrap.dataset.ok = ok === null ? "" : String(ok);
    }
    if (text) text.textContent = label ?? (ok === null ? "GPU: —" : ok ? "GPU: OK" : "GPU: nem elérhető");
  }

  setProgress(p: WidgetProgress): void {
    if (!this.shadow) return;
    const pct = Math.min(100, Math.max(0, p.percent));
    const bar = this.shadow.querySelector(".bae-progress-bar");
    const meta = this.shadow.querySelector(".bae-progress-meta");
    if (bar instanceof HTMLElement) bar.style.width = `${pct.toFixed(1)}%`;
    if (meta) {
      const parts = [p.label ?? "Letöltés", `${pct.toFixed(0)}%`];
      if (p.mbPerSec !== undefined) parts.push(`${p.mbPerSec.toFixed(1)} MB/s`);
      if (p.etaSec !== undefined) parts.push(`ETA ${fmtEta(p.etaSec)}`);
      meta.textContent = parts.join(" · ");
    }
  }

  setModels(list: WidgetModelEntry[]): void {
    const box = this.query(".bae-models");
    if (!canUseDom() || !box) return;
    box.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bae-empty";
      empty.textContent = "Nincs megjeleníthető modell.";
      box.appendChild(empty);
      return;
    }
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "bae-model-row";

      const name = document.createElement("span");
      name.className = "bae-model-name";
      name.textContent = m.label ?? m.id;
      name.title = m.id;

      const meta = document.createElement("span");
      meta.className = "bae-model-meta";
      meta.textContent = m.sizeMb !== undefined ? `${m.sizeMb} MB` : "";

      if (m.cached) {
        const badge = document.createElement("span");
        badge.className = "bae-model-badge";
        badge.dataset.cached = "true";
        badge.textContent = "cached";
        meta.appendChild(badge);
      }

      const load = document.createElement("button");
      load.className = "bae-btn";
      load.dataset.variant = "primary";
      load.dataset.action = "load";
      load.dataset.model = m.id;
      load.textContent = "Betöltés";

      const clear = document.createElement("button");
      clear.className = "bae-btn";
      clear.dataset.action = "clear";
      clear.dataset.model = m.id;
      clear.setAttribute("aria-label", `Cache törlése: ${m.id}`);
      clear.textContent = "Törlés";

      row.append(name, meta, load, clear);
      box.appendChild(row);
    }
  }

  setMemory(info: WidgetMemoryInfo): void {
    const el = this.query(".bae-memory");
    if (!el) return;
    const lines = [
      `Használat: ${fmtBytes(info.usageBytes)} / ${fmtBytes(info.quotaBytes)}`,
      `Cachelt modellek: ${info.cachedModels?.length ? info.cachedModels.join(", ") : "—"}`,
    ];
    if (info.note) lines.push(info.note);
    el.textContent = lines.join("\n");
  }

  // -- belső működés -------------------------------------------------------

  private query(sel: string): Element | null {
    if (!canUseDom() || !this.shadow) return null;
    return this.shadow.querySelector(sel);
  }

  private setOpen(value: boolean): void {
    this.open = value;
    if (!canUseDom() || !this.host) return;
    this.host.dataset.open = String(value);
    const fab = this.shadow?.querySelector(".bae-fab");
    if (fab instanceof HTMLElement) fab.setAttribute("aria-expanded", String(value));
    this.opts.onToggle?.(value);
    if (value) void this.refreshFromProviders();
  }

  /** getModels/getMemory újrahívása nyitáskor és Frissítés-gombra. */
  private async refreshFromProviders(): Promise<void> {
    try {
      if (this.opts.getModels) {
        const list = await this.opts.getModels();
        this.setModels(list);
      }
    } catch {
      this.setStatus("Modellista frissítése sikertelen.");
    }
    try {
      if (this.opts.getMemory) {
        const info = await this.opts.getMemory();
        this.setMemory(info);
      }
    } catch {
      // Memóriainfó nem kritikus: csendes kihagyás.
    }
  }

  private handleClick(ev: Event): void {
    const btn =
      ev.target instanceof HTMLElement ? ev.target.closest("[data-action]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.action;
    const model = btn.dataset.model;
    switch (action) {
      case "toggle":
        this.toggle();
        break;
      case "close":
        this.closePanel();
        break;
      case "refresh":
        void this.refreshFromProviders();
        break;
      case "load":
        if (model) void this.opts.onLoadModel?.(model);
        break;
      case "clear":
        void this.opts.onClearCache?.(model);
        break;
      case "clear-all":
        void this.opts.onClearCache?.(undefined);
        break;
      default:
        break;
    }
  }
}

/** Statikus markuphoz (XSS-védelemmel). Dinamikus listához a setModels DOM API-t használ. */
export function escapeHtml(value: string): string {
  return esc(value);
}
