import { defineConfig } from "tsup";

// Main bundle: library + framework adapters (ESM + CJS, with types).
// Worker bundle: separate entry, IIFE only — Web Workers can't resolve
// bare imports or CJS requires at runtime, so it ships self-contained.
export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/adapters/react.ts",
      "src/adapters/svelte.ts",
      "src/adapters/vue.ts",
      "src/adapters/solid.ts",
      "src/adapters/angular.ts",
      "src/adapters/store.ts",
      "src/adapters/webcomponent.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    minify: true,
    treeshake: true,
    outDir: "dist",
  },
  {
    entry: {
      "inference.worker": "src/worker/inference.worker.ts",
    },
    format: ["iife"],
    splitting: false,
    sourcemap: true,
    clean: false,
    minify: true,
    treeshake: true,
    outDir: "dist",
    dts: false,
    // A workernek önállónak kell lennie: Worker-környezetben nincs
    // bare-import feloldás, ezért a web-llm-et belecsomagoljuk.
    // (A fő belépési pontban ugyanez külső + CDN-visszaeséssel.)
    noExternal: ["@mlc-ai/web-llm"],
  },
]);
