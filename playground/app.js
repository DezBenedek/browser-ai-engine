/* browser-ai-engine playground — exercises every public feature. */
const $ = (id) => document.getElementById(id);

let LIB = null;
let engine = null;
let pipes = null;
let engineFingerprint = "";
let chatHistory = [];
let visionImage = null;

const LIB_FALLBACK = "https://esm.sh/browser-ai-engine@0.2.0";

function log(msg, kind = "") {
  const el = $("log");
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
  b.textContent = text;
  b.className = `badge ${cls}`;
}

// -- engine lifecycle -------------------------------------------------------

function currentFingerprint() {
  return JSON.stringify({
    worker: $("optWorker").checked,
    widget: $("optWidget").checked,
    theme: $("optTheme").value,
    position: $("optPosition").value,
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
      enabled: $("optWidget").checked,
      position: $("optPosition").value,
      theme: $("optTheme").value,
    },
    worker: { enabled: $("optWorker").checked },
  });
  engineFingerprint = fp;
  for (const ev of ["model-loading", "model-ready", "model-error", "progress", "memory"]) {
    engine.on(ev, (p) => log(`${ev}: ${JSON.stringify(p)?.slice(0, 220) ?? ""}`, ev === "model-error" ? "err" : ""));
  }
  pipes = new LIB.PipelineModule();
  setEngineBadge("ready", "ok");
  log(`Engine created (worker=${$("optWorker").checked}, widget=${$("optWidget").checked}).`, "ok");
  await renderModels();
  return engine;
}

// -- models tab --------------------------------------------------------------

function onLoadProgress(p) {
  $("dlProgressWrap").hidden = false;
  $("dlLabel").textContent = `${p.modelId} — ${p.status}`;
  $("dlPct").textContent = `${p.percent}%`;
  $("dlBar").style.width = `${Math.min(100, p.percent)}%`;
  const parts = [fmtMB(p.loadedBytes), "/", fmtMB(p.totalBytes)];
  if (p.mbPerSec) parts.push(`· ${p.mbPerSec} MB/s`);
  if (p.etaSec) parts.push(`· ETA ${p.etaSec}s`);
  $("dlMeta").textContent = parts.join(" ");
  if (p.status === "ready") {
    setTimeout(() => { $("dlProgressWrap").hidden = true; }, 1500);
  }
}

async function renderModels() {
  const groups = $("modelGroups");
  groups.innerHTML = "";
  let models = LIB.listModels();
  let cached = {};
  if (engine) {
    try {
      const detailed = await engine.listModelsDetailed();
      cached = Object.fromEntries(detailed.map((m) => [m.id, m.cached]));
    } catch (e) { log(`listModelsDetailed failed: ${e.message}`, "err"); }
  }
  $("modelCount").textContent = `(${models.length} models)`;
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
  try {
    const e = await ensureEngine();
    log(`Loading ${id}…`);
    await e.loadModel(id, onLoadProgress);
    log(`Loaded ${id}.`, "ok");
    await renderModels();
  } catch (err) {
    log(`loadModel(${id}) failed: ${err.message}`, "err");
  }
}

async function clearModel(id) {
  try {
    const e = await ensureEngine();
    await e.clearCache(id);
    log(`Cache cleared: ${id || "(all)"}.`, "ok");
    await renderModels();
  } catch (err) {
    log(`clearCache failed: ${err.message}`, "err");
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
  const div = document.createElement("div");
  div.className = `bubble ${cls || who}`;
  div.textContent = `${who}: ${text}`;
  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return div;
}

async function sendChat() {
  const q = $("chatInput").value.trim();
  if (!q) return;
  $("chatInput").value = "";
  try {
    const e = await ensureEngine();
    chatHistory.push({ role: "user", content: q });
    bubble("you", q);
    const aiDiv = bubble("ai", "…");
    const useTools = $("optTools").checked;
    const result = await e.chat({
      messages: chatHistory,
      tools: useTools ? DEMO_TOOLS : undefined,
      onChunk: (d) => {
        aiDiv.textContent = `ai: ${(aiDiv.dataset.full || "") + d}`;
        aiDiv.dataset.full = (aiDiv.dataset.full || "") + d;
        $("chatLog").scrollTop = $("chatLog").scrollHeight;
      },
    });
    aiDiv.textContent = `ai: ${result.text}`;
    chatHistory.push({ role: "assistant", content: result.text });
    $("toolJson").textContent = JSON.stringify(result.toolCalls, null, 2);
    if (result.toolCalls.length) {
      bubble("tool", `calls: ${JSON.stringify(result.toolCalls)}`, "tool");
      const dispatched = await LIB.ToolModule.dispatch(result.toolCalls, TOOL_HANDLERS);
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
      bubble("ai", follow.text);
      chatHistory.push({ role: "assistant", content: follow.text });
    }
  } catch (err) {
    log(`chat failed: ${err.message}`, "err");
    bubble("ai", `Error: ${err.message}`);
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
  const task = $("pipeTask").value;
  const sel = $("pipeModel");
  sel.innerHTML = "";
  for (const m of LIB.listModels(task)) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.id} (~${m.sizeMB} MB)`;
    sel.appendChild(o);
  }
  const box = $("pipeInputs");
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

function toVector(out) {
  // feature-extraction → Tensor | nested arrays. Mean-pool over sequence.
  let arr = out;
  if (arr && typeof arr.tolist === "function") arr = arr.tolist();
  if (arr && arr.data && arr.dims) {
    const [b, s, h] = arr.dims;
    const data = Array.from(arr.data);
    const vec = new Array(h).fill(0);
    const rows = b * s;
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < h; j++) vec[j] += data[i * h + j] / rows;
    return vec;
  }
  while (Array.isArray(arr) && Array.isArray(arr[0])) {
    const n = arr.length;
    const inner = arr[0].length;
    const mean = new Array(inner).fill(0);
    for (const row of arr) for (let j = 0; j < inner; j++) mean[j] += row[j] / n;
    arr = mean;
  }
  return Array.from(arr);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function runPipeline() {
  const task = $("pipeTask").value;
  const modelId = $("pipeModel").value;
  $("pipeOut").textContent = "Running…";
  try {
    await ensureEngine();
    // Warm the model through loadModel so download progress is visible.
    await engine.loadModel(modelId, onLoadProgress);
    let out;
    if (task === "zero-shot") {
      out = await pipes.run(modelId, pipeVal("text"), {
        taskOptions: { candidate_labels: pipeVal("labels").split(",").map((s) => s.trim()).filter(Boolean) },
      });
    } else if (task === "qa") {
      out = await pipes.run(modelId, pipeVal("context"), { taskOptions: { question: pipeVal("question") } });
    } else if (task === "summarization") {
      out = await pipes.run(modelId, `summarize: ${pipeVal("text")}`, { taskOptions: { max_new_tokens: 80 } });
    } else if (task === "embedding") {
      const a = toVector(await pipes.run(modelId, pipeVal("textA")));
      if (pipeVal("textB").trim()) {
        const b = toVector(await pipes.run(modelId, pipeVal("textB")));
        out = { dims: a.length, cosineSimilarity: cosine(a, b) };
      } else {
        out = { dims: a.length, preview: a.slice(0, 8) };
      }
    } else if (task === "rerank") {
      const query = pipeVal("query");
      const docs = pipeVal("docs").split("\n").map((s) => s.trim()).filter(Boolean);
      out = await pipes.run(modelId, docs.map((d) => [query, d]));
    } else {
      const key = task === "translation" || task === "text2text" ? "text" : "text";
      out = await pipes.run(modelId, pipeVal(key) || pipeVal("textA") || "");
    }
    $("pipeOut").textContent = JSON.stringify(out, null, 2)?.slice(0, 4000) ?? String(out);
    log(`pipeline ${modelId} ok.`, "ok");
  } catch (err) {
    $("pipeOut").textContent = `Error: ${err.message}`;
    log(`pipeline failed: ${err.message}`, "err");
  }
}

// -- vision tab --------------------------------------------------------------------

function refreshVisionModels() {
  const sel = $("visionModel");
  sel.innerHTML = "";
  for (const t of ["object-detection", "image-classification", "segmentation", "ocr"]) {
    for (const m of LIB.listModels(t)) {
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
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image."));
    img.src = url;
  });
}

async function runVision() {
  const modelId = $("visionModel").value;
  const file = $("visionFile").files[0];
  if (!file) { $("visionOut").textContent = "Pick an image first."; return; }
  $("visionOut").textContent = "Running…";
  try {
    await ensureEngine();
    await engine.loadModel(modelId, onLoadProgress);
    visionImage = await loadImageFile(file);
    const out = await pipes.run(modelId, visionImage);
    drawVision(visionImage, out);
    const printable = Array.isArray(out)
      ? out.map((o) => ({ ...o, mask: o.mask ? "[mask]" : undefined }))
      : out;
    $("visionOut").textContent = JSON.stringify(printable, null, 2)?.slice(0, 4000);
    log(`vision ${modelId} ok.`, "ok");
  } catch (err) {
    $("visionOut").textContent = `Error: ${err.message}`;
    log(`vision failed: ${err.message}`, "err");
  }
}

function drawVision(img, out) {
  const canvas = $("visionCanvas");
  const maxW = 640;
  const scale = Math.min(1, maxW / img.naturalWidth);
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (!Array.isArray(out)) return;
  // Segmentation mask?
  const seg = out.find((o) => o && o.mask && typeof o.mask.toCanvas === "function");
  if (seg) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(seg.mask.toCanvas(), 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }
  // Detection boxes (pixel coords of the original image).
  for (const o of out) {
    const b = o?.box;
    if (!b || typeof b.xmin !== "number") continue;
    const k = canvas.width / img.naturalWidth;
    ctx.strokeStyle = "#4f8cff";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.xmin * k, b.ymin * k, (b.xmax - b.xmin) * k, (b.ymax - b.ymin) * k);
    ctx.fillStyle = "#4f8cff";
    ctx.font = "12px system-ui";
    ctx.fillText(`${o.label} ${(o.score * 100).toFixed(0)}%`, b.xmin * k + 2, Math.max(12, b.ymin * k - 4));
  }
}

// -- audio tab -----------------------------------------------------------------------

async function transcribeBlob(blob, label) {
  $("sttOut").textContent = `${label}: transcribing…`;
  try {
    await ensureEngine();
    const model = $("sttModel").value;
    await engine.loadModel(model, onLoadProgress);
    const text = await engine.transcribe(blob);
    $("sttOut").textContent = text || "(empty)";
    log(`transcribed (${model}): ${text.slice(0, 120)}`, "ok");
  } catch (err) {
    $("sttOut").textContent = `Error: ${err.message}`;
    log(`transcribe failed: ${err.message}`, "err");
  }
}

async function recordMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    $("sttOut").textContent = "Recording 5s…";
    setTimeout(() => rec.stop(), 5000);
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    await transcribeBlob(new Blob(chunks, { type: "audio/webm" }), "mic");
  } catch (err) {
    $("sttOut").textContent = `Error: ${err.message}`;
    log(`mic failed: ${err.message}`, "err");
  }
}

async function speak() {
  const text = $("ttsInput").value.trim();
  if (!text) return;
  try {
    await ensureEngine();
    const blob = await engine.speak(text);
    if (blob.size > 0) {
      $("ttsAudio").src = URL.createObjectURL(blob);
      log(`TTS synthesized (${(blob.size / 1024).toFixed(0)} KB).`, "ok");
    } else {
      log("TTS via native speech synthesis (no audio blob).", "ok");
    }
  } catch (err) {
    log(`speak failed: ${err.message}`, "err");
  }
}

// -- system tab ------------------------------------------------------------------------

async function refreshSystem() {
  try {
    const e = await ensureEngine();
    const usage = await e.cache.usage();
    const mem = e.getMemory();
    const detailed = await e.listModelsDetailed();
    const cached = detailed.filter((m) => m.cached).map((m) => m.id);
    $("sysOut").textContent = JSON.stringify(
      { cache: usage, memory: mem, cachedModels: cached },
      null, 2,
    );
  } catch (err) {
    $("sysOut").textContent = `Error: ${err.message}`;
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
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    };
  });

  const libUrl = await resolveLibUrl();
  $("libSource").textContent = libUrl;
  try {
    LIB = await import(libUrl);
  } catch (err) {
    log(`Library load failed (${libUrl}): ${err.message}. Run npm run build or use ?lib=<url>.`, "err");
    return;
  }
  log(`Library loaded from ${libUrl}.`, "ok");

  const gpu = await LIB.BrowserAIEngine.isWebGPUSupported().catch(() => false);
  const badge = $("gpuBadge");
  badge.textContent = gpu ? "WebGPU OK" : "no WebGPU";
  badge.className = `badge ${gpu ? "ok" : "bad"}`;

  $("btnInit").onclick = () => ensureEngine().catch((e) => log(e.message, "err"));
  $("btnDispose").onclick = async () => {
    if (engine) { await engine.dispose().catch(() => undefined); engine = null; }
    setEngineBadge("idle");
    log("Engine disposed.");
  };
  for (const id of ["optWorker", "optWidget", "optTheme", "optPosition"]) {
    $(id).onchange = () => { if (engine) void ensureEngine(); };
  }

  $("btnSend").onclick = sendChat;
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") void sendChat(); });
  $("btnClearChat").onclick = () => { chatHistory = []; $("chatLog").innerHTML = ""; };
  $("pipeTask").onchange = refreshPipeModels;
  $("btnPipeRun").onclick = runPipeline;
  $("btnVisionRun").onclick = runVision;
  $("btnMic").onclick = recordMic;
  $("btnTranscribeFile").onclick = () => {
    const f = $("audioFile").files[0];
    if (!f) { $("sttOut").textContent = "Pick an audio file first."; return; }
    void transcribeBlob(f, f.name);
  };
  $("btnSpeak").onclick = speak;
  $("btnUsage").onclick = refreshSystem;
  $("btnPersist").onclick = async () => {
    const e = await ensureEngine();
    log(`Persistent storage: ${await e.cache.tryOpfsPersist()}.`);
    await refreshSystem();
  };
  $("btnClearAll").onclick = () => clearModel();
  $("btnClearLog").onclick = () => { $("log").innerHTML = ""; };

  // Static catalog immediately (cached flags upgrade after init).
  refreshPipeModels();
  refreshVisionModels();
  await renderModels();
  log("Playground ready. Press Init engine, then Load a model.", "ok");
}

boot();
