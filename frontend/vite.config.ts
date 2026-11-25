import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

function defaultServer() {
  try {
    const toml = readFileSync(resolve(__dirname, "../backend/server.toml"), "utf8");
    const port = toml.match(/^\s*port\s*=\s*(\d+)/m)?.[1];
    const address = toml.match(/^\s*public_addresses\s*=\s*\[\s*"([^"]+)"/m)?.[1];
    if (address && port) return `${address}:${port}`;
  } catch {}
  return "";
}

export default defineConfig({
  plugins: [sveltekit(), tailwind()],
  clearScreen: false,
  define: {
    "import.meta.env.VITE_DEFAULT_SERVER": JSON.stringify(defaultServer()),
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
