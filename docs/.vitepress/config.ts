import { defineConfig } from "vitepress";

export default defineConfig({
  title: "browser-ai-engine",
  description: "Offline-first LLM + speech engine for the browser.",
  base: "/browser-ai-engine/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "API", link: "/api-reference" },
      { text: "Examples", link: "/examples/vanilla" },
    ],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Guide", link: "/guide" },
          { text: "API reference", link: "/api-reference" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "Vanilla", link: "/examples/vanilla" },
          { text: "React", link: "/examples/react-example" },
          { text: "Svelte", link: "/examples/svelte-example" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/your-org/browser-ai-engine" },
    ],
  },
});
