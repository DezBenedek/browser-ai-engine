# Model catalog

37 built-in models in 9 categories. Every transformers.js `hfRepo` was verified
against the HuggingFace Hub (gated repos are excluded). `score` values are
indicative figures from model cards/papers, not our own measurements.

## Chat (WebGPU via WebLLM)

| ID | Size | Params | Ctx | Benchmark evals | Notes |
|---|---|---|---|---|---|
| `smollm2-135m` | ~150 MB | 135M | 8k | MMLU, ARC-c, HellaSwag | Smallest chat model; demos, weak hardware. |
| `smollm2-360m` | ~300 MB | 360M | 8k | MMLU, ARC-c, HellaSwag | Still tiny, clearly better following. |
| `qwen-2.5-0.5b` | ~400 MB | 0.5B | 4k | MMLU, HellaSwag, ARC-c | Default. |
| `llama-3.2-1b` | ~900 MB | 1B | 8k | MMLU, HellaSwag, ARC-c | Short instructions. |
| `qwen-2.5-1.5b` | ~1100 MB | 1.5B | 4k | MMLU, HellaSwag, ARC-c | Quality/size balance. |
| `deepseek-r1-distill-qwen-1.5b` | ~1200 MB | 1.5B | 4k | MMLU, GSM8K, ARC-c | Step-by-step reasoning traces. |
| `gemma-2-2b` | ~1800 MB | 2B | 8k | MMLU, HellaSwag, ARC-c | Strict instruction following. |
| `qwen-2.5-3b` | ~2200 MB | 3B | 4k | MMLU, HellaSwag, ARC-c | Tool-calling inclination. 4 GB+ VRAM. |
| `llama-3.2-3b` | ~2400 MB | 3B | 8k | MMLU, HellaSwag, ARC-c | Summarization, RAG. |
| `phi-3.5-mini` | ~2700 MB | 3.8B | 4k | MMLU, HumanEval, ARC-c | Code and reasoning. |

## Embedding & retrieval (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `embed-minilm-l6` | ~80 MB | 23M | MTEB, STS-B | Default RAG embedder. |
| `rerank-minilm-l6` | ~90 MB | 23M | MS MARCO, ~39 MRR@10 | Cross-encoder re-ranker. |
| `embed-minilm-l12` | ~120 MB | 33M | MTEB, STS-B | Slightly more accurate than L6. |
| `embed-bge-small` | ~130 MB | 33M | MTEB, BEIR | Strong retrieval quality. |
| `embed-e5-small` | ~130 MB | 33M | MTEB, BEIR | Prefix queries with `query: `. |
| `embed-gte-small` | ~130 MB | 33M | MTEB | Handles long texts. |

Typical RAG setup: `embed-minilm-l6` for recall, `rerank-minilm-l6` to re-order the top hits.

```ts
import { PipelineModule } from "browser-ai-engine";

const pipes = new PipelineModule();
const vec = await pipes.run("embed-minilm-l6", "What is WebGPU?");
const hits = await pipes.run("rerank-minilm-l6", ["What is WebGPU?", doc1, doc2]);
```

## Classification (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `zeroshot-mobilebert-mnli` | ~100 MB | 25M | MNLI, ~84% | Zero-shot with any labels, no training. |
| `sentiment-distilbert` | ~260 MB | 67M | SST-2, ~91% | English positive/negative. |

```ts
await pipes.run("sentiment-distilbert", "I love this!");
// → [{ label: 'POSITIVE', score: 0.99 }]
await pipes.run("zeroshot-mobilebert-mnli", "I love this!", {
  taskOptions: { candidate_labels: ["praise", "complaint"] },
});
```

## Comprehension: Q&A (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `qa-distilbert-squad` | ~260 MB | 67M | SQuAD v1.1, ~87 F1 | Cased English. |
| `qa-distilbert-uncased-squad` | ~260 MB | 67M | SQuAD v1.1 | For lowercase text. |

```ts
await pipes.run("qa-distilbert-squad", "WebGPU is a web standard.", {
  taskOptions: { question: "What is WebGPU?" },
});
```

## Generation (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `summarize-t5-small` | ~230 MB | 60M | CNN/DailyMail, XSum | Prefix with `summarize: ...`. |
| `instruct-flan-t5-small` | ~300 MB | 80M | MMLU, BBH | Instruction-tuned: summarize, answer, translate. |

## Translation (CPU, offline)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `translate-en-hu` | ~300 MB | 74M | WMT, Tatoeba | English → Hungarian. |
| `translate-hu-en` | ~300 MB | 74M | WMT, Tatoeba | Hungarian → English. |
| `translate-en-de` | ~300 MB | 74M | WMT, Tatoeba | English → German. |

```ts
await pipes.run("translate-en-hu", "The model runs in the browser.");
```

## Vision (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `segment-segformer-b0` | ~15 MB | 4M | ADE20K, 37.4 mIoU | 150-class segmentation. Smallest vision model. |
| `detect-yolos-tiny` | ~30 MB | 6M | COCO, ~29 box AP | Realtime detection, demos. |
| `classify-resnet50` | ~100 MB | 25M | ImageNet-1k, 76.1% top-1 | Classic 1000-class classifier. |
| `detect-detr-r50` | ~160 MB | 42M | COCO, 42.0 box AP | When YOLOS is not enough. |

```ts
await pipes.run("detect-yolos-tiny", imageBlob);
await pipes.run("segment-segformer-b0", imageBlob);
await pipes.run("classify-resnet50", imageBlob);
```

## Document: OCR (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `ocr-trocr-small` | ~250 MB | 62M | IAM, SROIE | Printed text; works best on cropped lines. |

## Speech (CPU)

| ID | Size | Params | Benchmark | Notes |
|---|---|---|---|---|
| `whisper-tiny` | ~150 MB | 39M | LibriSpeech, ~8 WER | Multilingual STT. |
| `whisper-tiny-en` | ~150 MB | 39M | LibriSpeech, ~7.5 WER | English-only, more accurate. |
| `whisper-base` | ~250 MB | 74M | LibriSpeech, ~5.5 WER | Still CPU-friendly. |
| `speecht5` | ~300 MB | 100M | LibriTTS | TTS, needs a speaker embedding. |

```ts
await ai.audio.transcribe(blob, { model: "whisper-tiny-en", language: "en" });
```

## Querying the catalog in code

```ts
import { MODEL_CATEGORIES, listModels, listModelsByCategory } from "browser-ai-engine";

MODEL_CATEGORIES; // ['Chat', 'Embedding & retrieval', ...] in display order
listModels("translation"); // ModelInfo[] filtered by task
listModelsByCategory("Vision"); // ModelInfo[] filtered by category
```
