/* browser-ai-engine playground — exercises every public feature. */
const $ = (id) => document.getElementById(id);

let LIB = null;
let engine = null;
let pipes = null;
let engineFingerprint = "";
let chatHistory = [];
let visionImage = null;
let progressSeq = 0;
let pipeBusy = false;
let visionBusy = false;
const pendingLoads = new Set();

const LIB_FALLBACK = "https://esm.sh/browser-ai-engine@0.2.0";

function log(msg, kind = "") {
  const el = $("log");
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.innerHTML = `<span class="t">[${time}]</span> ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function resolveLibUrl() {
  const param = new URLSearchParams(location.search).get("lib");
  if (param) return param;
  try {
    const r = await fetch("../dist/index.js", { method: "HEAD" });
    if (r.ok) return "../dist/index.js";
  } catch { /* file:// or no dist — fall through */ }
  return LIB_FALLBACK;
}

function fmtMB(bytes) {
  if (!bytes) return "—";
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function setEngineBadge(text, cls = "") {
  const b = $("engineBadge");
  if (!b) return;
  b.textContent = text;
  b.className = `badge ${cls}`;
}

// -- engine lifecycle -------------------------------------------------------

function currentFingerprint() {
  return JSON.stringify({
    worker: $("optWorker")?.checked ?? false,
    widget: $("optWidget")?.checked ?? false,
    theme: $("optTheme")?.value ?? "dark",
    position: $("optPosition")?.value ?? "bottom-right",
  });
}

async function ensureEngine() {
  const fp = currentFingerprint();
  if (engine && fp === engineFingerprint) return engine;
  if (engine) {
    try { await engine.dispose(); } catch { /* ignore */ }
    engine = null;
  }
  engine = new LIB.BrowserAIEngine({
    ui: {
      enabled: $("optWidget")?.checked ?? false,
      position: $("optPosition")?.value ?? "bottom-right",
      theme: $("optTheme")?.value ?? "dark",
    },
    worker: { enabled: $("optWorker")?.checked ?? false },
  });
  engineFingerprint = fp;
  for (const ev of ["model-loading", "model-ready", "model-error", "progress", "memory"]) {
    engine.on(ev, (p) => {
      let s = "";
      try { s = JSON.stringify(p)?.slice(0, 220) ?? ""; } catch { s = String(p ?? ""); }
      log(`${ev}: ${s}`, ev === "model-error" ? "err" : "");
    });
  }
  pipes = new LIB.PipelineModule();
  setEngineBadge("ready", "ok");
  log(`Engine created (worker=${$("optWorker")?.checked}, widget=${$("optWidget")?.checked}).`, "ok");
  await renderModels();
  return engine;
}

// -- models tab --------------------------------------------------------------

function onLoadProgress(p) {
  if (!p || typeof p !== "object") return;
  const wrap = $("dlProgressWrap");
  if (!wrap) return;
  const seq = ++progressSeq;
  wrap.hidden = false;
  const pct = Number.isFinite(p.percent) ? Math.min(100, Math.max(0, p.percent)) : 0;
  const lbl = $("dlLabel"); if (lbl) lbl.textContent = `${p.modelId ?? "?"} — ${p.status ?? ""}`;
  const pctEl = $("dlPct"); if (pctEl) pctEl.textContent = `${pct}%`;
  const bar = $("dlBar"); if (bar) bar.style.width = `${pct}%`;
  const parts = [fmtMB(p.loadedBytes), "/", fmtMB(p.totalBytes)];
  if (p.mbPerSec) parts.push(`· ${p.mbPerSec} MB/s`);
  if (p.etaSec) parts.push(`· ETA ${p.etaSec}s`);
  const meta = $("dlMeta"); if (meta) meta.textContent = parts.join(" ");
  if (p.status === "ready" || p.status === "cached" || p.status === "error") {
    setTimeout(() => { if (seq === progressSeq) wrap.hidden = true; }, 1500);
  }
}

async function renderModels() {
  const groups = $("modelGroups");
  if (!groups || !LIB?.listModels || !LIB?.MODEL_CATEGORIES) return;
  groups.innerHTML = "";
  let models = LIB.listModels();
  let cached = {};
  if (engine) {
    try {
      const detailed = await engine.listModelsDetailed();
      cached = Object.fromEntries(detailed.map((m) => [m.id, m.cached]));
    } catch (e) { log(`listModelsDetailed failed: ${e?.message || e}`, "err"); }
  }
  const mc = $("modelCount");
  if (mc) mc.textContent = `(${models.length} models)`;
  for (const cat of LIB.MODEL_CATEGORIES) {
    const rows = models.filter((m) => m.category === cat);
    if (!rows.length) continue;
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = cat;
    groups.appendChild(h);
    const table = document.createElement("table");
    table.className = "models";
    table.innerHTML = `<tr><th>Model</th><th>Size</th><th>Benchmark</th><th>Cached</th><th></th></tr>`;
    for (const m of rows) {
      const tr = document.createElement("tr");
      const bench = m.score ?? (m.evals || []).slice(0, 2).join(", ");
      const isCached = cached[m.id];
      tr.innerHTML =
        `<td><strong>${m.id}</strong><br/><span class="muted small">${m.label} · ${m.params}</span></td>` +
        `<td>~${m.sizeMB} MB</td><td class="small">${bench || "—"}</td>` +
        `<td>${isCached === undefined ? "—" : `<span class="pill${isCached ? " cached" : ""}">${isCached ? "cached" : "remote"}</span>`}</td>`;
      const td = document.createElement("td");
      const bLoad = document.createElement("button");
      bLoad.textContent = "Load";
      bLoad.className = "small";
      bLoad.onclick = () => loadModel(m.id);
      const bClear = document.createElement("button");
      bClear.textContent = "Clear";
      bClear.className = "small";
      bClear.onclick = () => clearModel(m.id);
      td.append(bLoad, " ", bClear);
      tr.appendChild(td);
      table.appendChild(tr);
    }
    groups.appendChild(table);
  }
}

async function loadModel(id) {
  if (!id) { log("loadModel: pick a model first.", "err"); return; }
  if (pendingLoads.has(id)) { log(`Already loading ${id}…`); return; }
  pendingLoads.add(id);
  try {
    const e = await ensureEngine();
    log(`Loading ${id}…`);
    await e.loadModel(id, onLoadProgress);
    log(`Loaded ${id}.`, "ok");
    await renderModels();
  } catch (err) {
    onLoadProgress({ modelId: id, status: "error", percent: 100, loadedBytes: 0, totalBytes: 0 });
    log(`loadModel(${id}) failed: ${err?.message || err}`, "err");
  } finally {
    pendingLoads.delete(id);
  }
}

async function clearModel(id) {
  try {
    const e = await ensureEngine();
    await e.clearCache(id);
    log(`Cache cleared: ${id || "(all)"}.`, "ok");
    await renderModels();
  } catch (err) {
    log(`clearCache failed: ${err?.message || err}`, "err");
  }
}

// -- chat tab ------------------------------------------------------------------

const DEMO_TOOLS = [
  {
    name: "getWeather",
    description: "Get current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "calculator",
    description: "Evaluate a simple arithmetic expression.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
];

const TOOL_HANDLERS = {
  getWeather: async ({ city }) => ({ city, tempC: 21, condition: "sunny (demo data)" }),
  calculator: async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) throw new Error("unsafe expression");
    return { result: Function(`"use strict"; return (${expression})`)() };
  },
};

function bubble(who, text, cls = "") {
  const logEl = $("chatLog");
  if (!logEl) return null;
  const div = document.createElement("div");
  div.className = `bubble ${cls || who}`;
  div.textContent = `${who}: ${text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

// Friendly hint when no chat model is active (nothing loaded or other task).
function chatGuidance(eng) {
  const id = eng?.currentModelId;
  if (!id) return "No model loaded. Models tab → Chat → Load one first (e.g. qwen-2.5-0.5b), then send again.";
  let task = null;
  try {
    const fromReg = LIB?.MODEL_REGISTRY?.[id];
    const fromList = fromReg || (LIB?.listModels ? LIB.listModels().find((m) => m.id === id) : null);
    task = fromList?.task || null;
  } catch { task = null; }
  if (task && task !== "chat") return `Loaded model "${id}" is a ${task} model, not chat. Load a chat model first.`;
  return null;
}

async function sendChat() {
  const input = $("chatInput");
  const q = input?.value.trim() || "";
  if (!q) return;
  input.value = "";
  let e = null;
  let aiDiv = null;
  try {
    e = await ensureEngine();
    const hint = chatGuidance(e);
    if (hint) {
      chatHistory.push({ role: "user", content: q });
      bubble("you", q);
      bubble("ai", hint);
      log("chat blocked: no chat model loaded.", "err");
      return;
    }
    chatHistory.push({ role: "user", content: q });
    bubble("you", q);
    aiDiv = bubble("ai", "…");
    const useTools = $("optTools")?.checked;
    const result = await e.chat({
      messages: chatHistory,
      tools: useTools ? DEMO_TOOLS : undefined,
      onChunk: (d) => {
        if (!aiDiv) return;
        const delta = typeof d === "string" ? d : String(d ?? "");
        aiDiv.textContent = `ai: ${(aiDiv.dataset.full || "") + delta}`;
        aiDiv.dataset.full = (aiDiv.dataset.full || "") + delta;
        const cl = $("chatLog");
        if (cl) cl.scrollTop = cl.scrollHeight;
      },
    });
    const text = result?.text || "(empty response)";
    if (aiDiv) aiDiv.textContent = `ai: ${text}`;
    chatHistory.push({ role: "assistant", content: text });
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    $("toolJson").textContent = JSON.stringify(calls, null, 2);
    if (calls.length) {
      bubble("tool", `calls: ${JSON.stringify(calls)}`, "tool");
      const dispatchFn = LIB?.ToolModule?.dispatch || LIB?.dispatch;
      if (typeof dispatchFn !== "function") throw new Error("ToolModule.dispatch not available in this LIB build.");
      const dispatched = await dispatchFn(calls, TOOL_HANDLERS);
      log(`tools dispatched: ${JSON.stringify(dispatched).slice(0, 300)}`, "ok");
      // Follow-up turn so the model answers with the tool results.
      const follow = await e.chat({
        messages: [
          ...chatHistory,
          {
            role: "user",
            content: `Tool results: ${JSON.stringify(dispatched)}. Answer my original question now.`,
          },
        ],
      });
      const ftext = follow?.text || "(empty response)";
      bubble("ai", ftext);
      chatHistory.push({ role: "assistant", content: ftext });
    }
  } catch (err) {
    const msg = err?.message || String(err);
    log(`chat failed: ${msg}`, "err");
    let hint = null;
    try { hint = chatGuidance(e || engine); } catch { hint = null; }
    if (!hint && /Nincs betöltött|nincs.*betöltve|loadModel|WebGPU|no.*model/i.test(msg)) {
      hint = "Load a chat model first: Models tab → Chat → Load (e.g. qwen-2.5-0.5b).";
    }
    const full = hint ? `${msg} — ${hint}` : msg;
    if (aiDiv && aiDiv.textContent === "ai: …") aiDiv.textContent = `ai: Error: ${full}`;
    else bubble("ai", `Error: ${full}`);
  }
}

// -- pipelines tab ---------------------------------------------------------------

const PIPE_INPUTS = {
  "text-classification": [{ key: "text", label: "Text", kind: "textarea", value: "I love running models in the browser!" }],
  "zero-shot": [
    { key: "text", label: "Text", kind: "textarea", value: "The team won the championship final." },
    { key: "labels", label: "Labels (comma separated)", kind: "input", value: "sports, politics, tech" },
  ],
  qa: [
    { key: "context", label: "Context", kind: "textarea", value: "WebGPU is a web standard for GPU-accelerated computing in the browser." },
    { key: "question", label: "Question", kind: "input", value: "What is WebGPU?" },
  ],
  summarization: [{ key: "text", label: "Text (prefix 'summarize: ' is added)", kind: "textarea", value: "Transformers run in the browser with WebGPU and WASM. Models download once, then work offline from the browser cache." }],
  text2text: [{ key: "text", label: "Instruction", kind: "textarea", value: "Translate to German: The browser runs AI models locally." }],
  translation: [{ key: "text", label: "Text", kind: "textarea", value: "The model runs entirely in your browser." }],
  embedding: [
    { key: "textA", label: "Text A", kind: "textarea", value: "The cat sits on the mat." },
    { key: "textB", label: "Text B (optional — cosine similarity)", kind: "textarea", value: "A cat is lying on a rug." },
  ],
  rerank: [
    { key: "query", label: "Query", kind: "input", value: "browser AI inference" },
    { key: "docs", label: "Documents (one per line)", kind: "textarea", value: "WebGPU runs neural networks in the browser.\nCats are popular pets.\nTransformers.js brings HuggingFace models to JavaScript." },
  ],
};

function refreshPipeModels() {
  const task = $("pipeTask")?.value || "text-classification";
  const sel = $("pipeModel");
  if (!sel || !LIB?.listModels) return;
  sel.innerHTML = "";
  let list = [];
  try { list = LIB.listModels(task); } catch { list = []; }
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.id} (~${m.sizeMB} MB)`;
    sel.appendChild(o);
  }
  const box = $("pipeInputs");
  if (!box) return;
  box.innerHTML = "";
  for (const inp of PIPE_INPUTS[task] || []) {
    const label = document.createElement("label");
    label.textContent = inp.label;
    let el;
    if (inp.kind === "textarea") {
      el = document.createElement("textarea");
      el.className = "ta";
    } else {
      el = document.createElement("input");
    }
    el.id = `pipe_${inp.key}`;
    el.value = inp.value;
    label.appendChild(el);
    box.appendChild(label);
  }
}

const pipeVal = (k) => $(`pipe_${k}`)?.value ?? "";

function toTensorArray(out) {
  // Tensor-like → plain nested arrays (tolist() or {data,dims}).
  let arr = out;
  if (arr && typeof arr.tolist === "function") {
    try { arr = arr.tolist(); } catch { /* fall through */ }
  }
  if (arr && typeof arr === "object" && ArrayBuffer.isView(arr.data) && Array.isArray(arr.dims)) {
    return { data: Array.from(arr.data, (v) => (typeof v === "bigint" ? Number(v) : v)), dims: arr.dims };
  }
  return arr;
}

function toVector(out) {
  // feature-extraction → 1D vector (mean-pool over all but last dim).
  let arr = toTensorArray(out);
  if (arr && typeof arr === "object" && Array.isArray(arr.dims) && Array.isArray(arr.data)) {
    const dims = arr.dims;
    const h = dims[dims.length - 1];
    const data = arr.data;
    if (!Number.isInteger(h) || h <= 0 || data.length === 0) throw new Error("embedding: empty model response.");
    const rows = Math.max(1, Math.floor(data.length / h));
    const vec = new Array(h).fill(0);
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < h; j++) vec[j] += (Number(data[i * h + j]) || 0) / rows;
    return vec;
  }
  while (Array.isArray(arr) && Array.isArray(arr[0])) {
    const n = arr.length;
    if (!n) throw new Error("embedding: empty model response.");
    const inner = arr[0].length;
    const mean = new Array(inner).fill(0);
    for (const row of arr) for (let j = 0; j < inner; j++) mean[j] += (Number(row[j]) || 0) / n;
    arr = mean;
  }
  if (!Array.isArray(arr)) throw new Error("embedding: unexpected model response (not a vector).");
  if (!arr.length) throw new Error("embedding: empty model response.");
  return arr.map((v) => Number(v) || 0);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Robust pipeline output → text (string/Tensor/list/empty, BigInt-safe).
function formatOut(out) {
  if (out === null || out === undefined) return "(empty response)";
  if (typeof out === "string") return out === "" ? "(empty response)" : out.slice(0, 4000);
  const conv = toTensorArray(out);
  const val = conv !== out ? conv : out;
  if (Array.isArray(val) && val.length === 0) return "(empty response: [])";
  try {
    const s = JSON.stringify(val, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2);
    if (typeof s !== "string" || s === "") return String(val ?? "(empty response)");
    return s.slice(0, 4000);
  } catch {
    try { return String(val).slice(0, 4000); } catch { return "(unprintable response)"; }
  }
}

async function runPipeline() {
  if (pipeBusy) { log("Pipeline already running…"); return; }
  const task = $("pipeTask")?.value || "text-classification";
  const modelId = $("pipeModel")?.value || "";
  const outEl = $("pipeOut");
  if (outEl) outEl.textContent = "Running…";
  if (!modelId) {
    if (outEl) outEl.textContent = "No model for this task. Pick another task.";
    log("pipeline blocked: empty model select.", "err");
    return;
  }
  if (!pipes && LIB?.PipelineModule) pipes = new LIB.PipelineModule();
  pipeBusy = true;
  try {
    const e = await ensureEngine();
    // Warm the model through loadModel so download progress is visible.
    await e.loadModel(modelId, onLoadProgress);
    let out;
    if (task === "zero-shot") {
      const labels = pipeVal("labels").split(",").map((s) => s.trim()).filter(Boolean);
      if (!pipeVal("text").trim() || !labels.length) throw new Error("zero-shot: enter text and at least one label.");
      out = await pipes.run(modelId, pipeVal("text"), {
        taskOptions: { candidate_labels: labels },
      });
    } else if (task === "qa") {
      if (!pipeVal("context").trim() || !pipeVal("question").trim()) throw new Error("qa: enter both context and question.");
      out = await pipes.run(modelId, pipeVal("context"), { taskOptions: { question: pipeVal("question") } });
    } else if (task === "summarization") {
      if (!pipeVal("text").trim()) throw new Error("summarization: enter text first.");
      out = await pipes.run(modelId, `summarize: ${pipeVal("text")}`, { taskOptions: { max_new_tokens: 80 } });
    } else if (task === "embedding") {
      if (!pipeVal("textA").trim()) throw new Error("embedding: enter Text A first.");
      const a = toVector(await pipes.run(modelId, pipeVal("textA")));
      if (pipeVal("textB").trim()) {
        const b = toVector(await pipes.run(modelId, pipeVal("textB")));
        out = { dims: a.length, cosineSimilarity: cosine(a, b) };
      } else {
        out = { dims: a.length, preview: a.slice(0, 8) };
      }
    } else if (task === "rerank") {
      const query = pipeVal("query").trim();
      const docs = pipeVal("docs").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!query || !docs.length) throw new Error("rerank: enter a query and at least one document (one per line).");
      try {
        out = await pipes.run(modelId, docs.map((d) => [query, d]));
      } catch (err) {
        throw new Error(`rerank paired call failed (model ${modelId}, ${docs.length} pairs): ${err?.message || err}`);
      }
    } else {
      const text = pipeVal("text") || pipeVal("textA") || "";
      if (!text.trim()) throw new Error(`${task}: enter text first.`);
      out = await pipes.run(modelId, text);
    }
    if (outEl) outEl.textContent = formatOut(out);
    log(`pipeline ${modelId} ok.`, "ok");
  } catch (err) {
    const msg = err?.message || String(err);
    if (outEl) outEl.textContent = `Error: ${msg}`;
    log(`pipeline failed: ${msg}`, "err");
  } finally {
    pipeBusy = false;
  }
}

// -- vision tab --------------------------------------------------------------------

function refreshVisionModels() {
  const sel = $("visionModel");
  if (!sel || !LIB?.listModels) return;
  sel.innerHTML = "";
  for (const t of ["object-detection", "image-classification", "segmentation", "ocr"]) {
    let list = [];
    try { list = LIB.listModels(t); } catch { list = []; }
    for (const m of list) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.id} (~${m.sizeMB} MB)`;
      sel.appendChild(o);
    }
  }
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode image.")); };
    img.src = url;
  });
}

async function runVision() {
  if (visionBusy) { log("Vision already running…"); return; }
  const modelId = $("visionModel")?.value || "";
  const file = $("visionFile")?.files?.[0];
  const outEl = $("visionOut");
  if (!file) { if (outEl) outEl.textContent = "Pick an image first."; return; }
  if (!modelId) { if (outEl) outEl.textContent = "No vision model available."; return; }
  if (outEl) outEl.textContent = "Running…";
  if (!pipes && LIB?.PipelineModule) pipes = new LIB.PipelineModule();
  visionBusy = true;
  try {
    const e = await ensureEngine();
    await e.loadModel(modelId, onLoadProgress);
    visionImage = await loadImageFile(file);
    const out = await pipes.run(modelId, visionImage);
    drawVision(visionImage, out);
    const printable = Array.isArray(out)
      ? out.map((o) => (o && typeof o === "object" ? { ...o, mask: o.mask ? "[mask]" : undefined } : o))
      : out;
    if (outEl) outEl.textContent = formatOut(printable);
    log(`vision ${modelId} ok.`, "ok");
  } catch (err) {
    const msg = err?.message || String(err);
    if (outEl) outEl.textContent = `Error: ${msg}`;
    log(`vision failed: ${msg}`, "err");
  } finally {
    visionBusy = false;
  }
}

function drawVision(img, out) {
  const canvas = $("visionCanvas");
  if (!canvas || !img?.naturalWidth) return;
  const maxW = 640;
  const scale = Math.min(1, maxW / img.naturalWidth);
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (!Array.isArray(out)) return;
  // Segmentation mask?
  const seg = out.find((o) => o && o.mask && typeof o.mask.toCanvas === "function");
  if (seg) {
    try {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(seg.mask.toCanvas(), 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    } catch { ctx.globalAlpha = 1; }
  }
  // Detection boxes (pixel coords of the original image).
  for (const o of out) {
    const b = o?.box;
    if (!b || typeof b.xmin !== "number" || typeof b.ymin !== "number") continue;
    const k = canvas.width / img.naturalWidth;
    ctx.strokeStyle = "#4f8cff";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.xmin * k, b.ymin * k, (b.xmax - b.xmin) * k, (b.ymax - b.ymin) * k);
    ctx.fillStyle = "#4f8cff";
    ctx.font = "12px system-ui";
    const label = typeof o?.label === "string" ? o.label : "obj";
    const score = typeof o?.score === "number" ? ` ${(o.score * 100).toFixed(0)}%` : "";
    ctx.fillText(`${label}${score}`, b.xmin * k + 2, Math.max(12, b.ymin * k - 4));
  }
}

// -- audio tab -----------------------------------------------------------------------

async function transcribeBlob(blob, label) {
  const outEl = $("sttOut");
  if (outEl) outEl.textContent = `${label}: transcribing…`;
  try {
    const e = await ensureEngine();
    const model = $("sttModel")?.value || "whisper-tiny";
    await e.loadModel(model, onLoadProgress);
    const text = await e.transcribe(blob, { model });
    if (outEl) outEl.textContent = text || "(empty)";
    log(`transcribed (${model}): ${String(text || "").slice(0, 120)}`, "ok");
  } catch (err) {
    const msg = err?.message || String(err);
    if (outEl) outEl.textContent = `Error: ${msg}`;
    log(`transcribe failed: ${msg}`, "err");
  }
}

async function recordMic() {
  const outEl = $("sttOut");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    if (outEl) outEl.textContent = "Recording 5s…";
    setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, 5000);
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) throw new Error("Empty recording (no audio captured).");
    await transcribeBlob(new Blob(chunks, { type: "audio/webm" }), "mic");
  } catch (err) {
    const msg = err?.message || String(err);
    if (outEl) outEl.textContent = `Error: ${msg}`;
    log(`mic failed: ${msg}`, "err");
  }
}

async function speak() {
  const text = $("ttsInput")?.value.trim() || "";
  if (!text) return;
  try {
    const e = await ensureEngine();
    const blob = await e.speak(text);
    if (blob && blob.size > 0) {
      const audio = $("ttsAudio");
      if (audio) {
        if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
        audio.src = URL.createObjectURL(blob);
      }
      log(`TTS synthesized (${(blob.size / 1024).toFixed(0)} KB).`, "ok");
    } else {
      log("TTS via native speech synthesis (no audio blob).", "ok");
    }
  } catch (err) {
    log(`speak failed: ${err?.message || err}`, "err");
  }
}

// -- system tab ------------------------------------------------------------------------

async function refreshSystem() {
  const outEl = $("sysOut");
  try {
    const e = await ensureEngine();
    const usage = await e.cache.usage();
    const mem = e.getMemory();
    const detailed = await e.listModelsDetailed();
    const cached = detailed.filter((m) => m.cached).map((m) => m.id);
    if (outEl) outEl.textContent = JSON.stringify(
      { cache: usage, memory: mem, cachedModels: cached },
      null, 2,
    );
  } catch (err) {
    if (outEl) outEl.textContent = `Error: ${err?.message || err}`;
  }
}

// -- boot -------------------------------------------------------------------------------

async function boot() {
  // Tabs
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tabpage").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`)?.classList.add("active");
    };
  });

  const libUrl = await resolveLibUrl();
  const srcEl = $("libSource");
  if (srcEl) srcEl.textContent = libUrl;
  try {
    LIB = await import(libUrl);
  } catch (err) {
    log(`Library load failed (${libUrl}): ${err?.message || err}. Run npm run build or use ?lib=<url>.`, "err");
    return;
  }
  if (!LIB?.BrowserAIEngine || !LIB?.PipelineModule || typeof LIB?.listModels !== "function") {
    log(`Library from ${libUrl} misses exports (BrowserAIEngine/PipelineModule/listModels).`, "err");
    return;
  }
  log(`Library loaded from ${libUrl}.`, "ok");

  let gpu = false;
  try { gpu = await LIB.BrowserAIEngine.isWebGPUSupported(); } catch { gpu = false; }
  const badge = $("gpuBadge");
  if (badge) {
    badge.textContent = gpu ? "WebGPU OK" : "no WebGPU";
    badge.className = `badge ${gpu ? "ok" : "bad"}`;
  }

  $("btnInit").onclick = () => ensureEngine().catch((e) => log(e?.message || e, "err"));
  $("btnDispose").onclick = async () => {
    if (engine) { await engine.dispose().catch(() => undefined); engine = null; }
    pipes = null;
    progressSeq++;
    const wrap = $("dlProgressWrap");
    if (wrap) wrap.hidden = true;
    setEngineBadge("idle");
    log("Engine disposed.");
  };
  for (const id of ["optWorker", "optWidget", "optTheme", "optPosition"]) {
    const el = $(id);
    if (el) el.onchange = () => { if (engine) void ensureEngine(); };
  }

  $("btnSend").onclick = sendChat;
  $("chatInput")?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void sendChat(); });
  $("btnClearChat").onclick = () => { chatHistory = []; const cl = $("chatLog"); if (cl) cl.innerHTML = ""; };
  $("pipeTask").onchange = refreshPipeModels;
  $("btnPipeRun").onclick = runPipeline;
  $("btnVisionRun").onclick = runVision;
  $("btnMic").onclick = recordMic;
  $("btnTranscribeFile").onclick = () => {
    const f = $("audioFile")?.files?.[0];
    if (!f) { const o = $("sttOut"); if (o) o.textContent = "Pick an audio file first."; return; }
    void transcribeBlob(f, f.name);
  };
  $("btnSpeak").onclick = speak;
  $("btnUsage").onclick = refreshSystem;
  $("btnPersist").onclick = async () => {
    try {
      const e = await ensureEngine();
      log(`Persistent storage: ${await e.cache.tryOpfsPersist()}.`);
      await refreshSystem();
    } catch (err) { log(`persist failed: ${err?.message || err}`, "err"); }
  };
  $("btnClearAll").onclick = () => clearModel();
  $("btnClearLog").onclick = () => { const l = $("log"); if (l) l.innerHTML = ""; };

  // Static catalog immediately (cached flags upgrade after init).
  refreshPipeModels();
  refreshVisionModels();
  await renderModels();
  log("Playground ready. Press Init engine, then Load a model.", "ok");
}

boot();
