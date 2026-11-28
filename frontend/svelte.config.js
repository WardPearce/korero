import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: "dist", assets: "dist", fallback: "index.html" }),
    alias: { "#lib": "./src/lib" },
    csp: {
      mode: "auto",
      directives: {
        "script-src": ["self"],
        "worker-src": ["self", "blob:"], // Tone.js creates a Blob worker for UI sounds.
        "object-src": ["none"],
        "frame-src": ["none"],
        "base-uri": ["none"],
      },
    },
  },
};
