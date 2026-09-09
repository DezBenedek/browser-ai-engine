import { defineConfig } from "vitepress";

export default defineConfig({
  title: "browser-ai-engine",
  description: "Offline-first LLM + speech engine for the browser.",
  base: "/browser-ai-engine/",
  // /playground/ is a static app copied into public/ by CI (see deploy-docs.yml),
  // not a markdown route — exempt it from the dead-link checker.
  ignoreDeadLinks: [/\/playground/],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "API", link: "/api-reference" },
      { text: "Examples", link: "/examples/vanilla" },
      { text: "Playground", link: "/playground/" },
    ],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Guide", link: "/guide" },
          { text: "API reference", link: "/api-reference" },
          { text: "Model catalog", link: "/models" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "Vanilla", link: "/examples/vanilla" },
          { text: "React", link: "/examples/react" },
          { text: "Svelte", link: "/examples/svelte" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/DezBenedek/browser-ai-engine" },
    ],
  },
});
