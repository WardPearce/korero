import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { parse } from "smol-toml";
import { defineConfig } from "vite";

function loadBackendConfig() {
  const backend = resolve(__dirname, "../backend");
  const directory = resolve(backend, process.env.VOICE_DATA_DIR ?? "data");
  const file = process.env.VOICE_CONFIG ? resolve(backend, process.env.VOICE_CONFIG)
    : [resolve(directory, "server.toml"), resolve(backend, "server.toml")].find(existsSync);
  return file ? parse(readFileSync(file, "utf8")) : {};
}

export default defineConfig(({ command, isPreview }) => {
  const config = command === "serve" && !isPreview ? loadBackendConfig() : {};
  const server = config.server as { port?: number; public_addresses?: string[] } | undefined;
  const port = Number(process.env.VOICE_SERVER_PORT ?? server?.port ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid backend server port");
  const addresses = process.env.VOICE_SERVER_PUBLIC_ADDRESSES;
  const address = (addresses === undefined ? server?.public_addresses : JSON.parse(addresses))?.[0];
  const voiceServer = typeof address === "string" && address ? `${isIP(address) === 6 ? `[${address}]` : address}:${port}` : "";
  const tls = config.tls as { mode?: string } | undefined;
  const backendProtocol = (process.env.VOICE_TLS_MODE ?? tls?.mode) === "proxy" ? "http" : "https";

  return {
    plugins: [tailwindcss(), sveltekit()],
    clearScreen: false,
    define: {
      "import.meta.env.VITE_DEFAULT_SERVER": JSON.stringify(voiceServer),
      "import.meta.env.VITE_DEV_ACCOUNT_PROVIDER": JSON.stringify(`localhost:${port}`),
    },
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      proxy: {
        "/api/v1/hosted-account/": {
          target: `${backendProtocol}://127.0.0.1:${port}`,
          // The development backend generates a self-signed loopback certificate.
          secure: false,
          changeOrigin: true,
        },
      },
      // Ignore SDK files from earlier desktop builds.
      watch: {
        ignored: ["**/.native/**"],
      },
    },
  };
});
