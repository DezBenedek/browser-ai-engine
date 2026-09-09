# Playground

Interactive test UI for every feature: model catalog with download progress,
streaming chat with tool calling, text pipelines, vision, audio, cache management.

**Open it:** [Launch playground](./playground/) (served with the docs site).

Local development:

```bash
npm run build
npx serve .   # or: python3 -m http.server
# open http://localhost:3000/playground/
```

The playground loads `../dist/index.js` when present (after `npm run build`),
otherwise it falls back to the published esm.sh build (`?lib=<url>` override supported).
Source: [`playground/`](https://github.com/DezBenedek/browser-ai-engine/tree/main/playground).
