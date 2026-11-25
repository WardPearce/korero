import { resolve } from "node:path";
import { chromium } from "playwright";
import { fingerprint } from "../../src/security/tls";
import { fixture, until } from "../server";
import type { harness } from "./browser";

declare global { interface Window { harness: typeof harness } }

const executable = resolve(process.env.KORERO_VOICE_PROBE ?? "../frontend/native/target/debug/voice-probe");
const server = await fixture({});
try {
  const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/browser.ts"], target: "browser", format: "iife" });
  if (!bundle.success) throw new Error("Could not build the browser peer");
  const trustedKey = fingerprint(server.ca).slice("sha256/".length);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors-spki-list=" + trustedKey] });
  try {
    await server.owner();
    const page = await browser.newPage();
    await page.goto(server.origin + "/api/v1/server/info");
    await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
    await page.evaluate(async () => {
      await window.harness.initialize("Chromium voice probe");
      await window.harness.publish(false);
    });
    const ca = server.directory + "/probe-public.crt";
    await Bun.write(ca, server.ca);
    const credentials = await server.register("Rust voice probe");
    const native = Bun.spawn([executable, server.origin, ca], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    type Result = { ready?: number; left?: number; connectionId?: string; decoded?: number; peak?: number };
    const results: Result[] = [];
    const collectResults = (async () => {
      let tail = "";
      for await (const chunk of native.stdout.pipeThrough(new TextDecoderStream())) {
        const lines = (tail + chunk).split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) results.push(JSON.parse(line) as Result);
      }
    })();
    try {
      native.stdin.write(JSON.stringify(credentials) + "\n");
      await native.stdin.flush();
      let previousConnection: string | undefined;
      for (const round of [1, 2]) {
        const ready = await until(async () => {
          const result = results.find((entry) => entry.ready === round);
          if (native.exitCode !== null) throw new Error(`Native probe exited with ${native.exitCode}`);
          return result;
        }, Boolean, 12000);
        if (!ready?.connectionId || ready.connectionId === previousConnection) throw new Error("Expected a fresh native connection");
        previousConnection = ready.connectionId;
        const producer = await until(() => page.evaluate(async (id) => {
          const list = await window.harness.rpc<{ connectionId: string; producerId: string }[]>("media.producers");
          return list.find((entry) => entry.connectionId === id)?.producerId;
        }, ready.connectionId), Boolean);
        const inbound = await page.evaluate((producerId) => window.harness.consume(producerId!, false), producer);
        if (inbound.codec.toLowerCase() !== "audio/opus" || inbound.packets <= 0) throw new Error("Chromium did not decode Opus");
        const nativeAudio = await until(async () => results.find((entry) => entry.decoded === round), Boolean);
        if (!nativeAudio?.peak || nativeAudio.peak < 0.025) throw new Error("Native peer did not decode audio");
        console.log(`Round ${round}: Opus decoded in both directions (native peak ${nativeAudio.peak.toFixed(3)}, browser peak ${inbound.peak.toFixed(3)})`);
        native.stdin.write("leave\n");
        await native.stdin.flush();
        await until(async () => results.some((entry) => entry.left === round), Boolean);
        await until(() => page.evaluate((id) => window.harness.events().some(({ type, payload }) =>
          type === "media.producerClosed" && payload.producerId === id), producer), Boolean);
      }
      if (await native.exited !== 0) throw new Error("Failed to exit after reconnect");
    } finally {
      if (native.exitCode === null) native.kill();
      await native.exited;
      await collectResults;
    }
  } finally { await browser.close(); }
} finally { await server.cleanup(); }
