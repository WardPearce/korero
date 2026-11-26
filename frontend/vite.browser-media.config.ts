import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/browser-media", import.meta.url)),
  base: "/media/",
  plugins: [tailwindcss(), svelte()],
  resolve: { alias: { "#lib": fileURLToPath(new URL("./src/lib", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("./dist/media", import.meta.url)),
    emptyOutDir: true,
  },
});
