import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/security/files";
import { version } from "mediasoup";
import type { send, receive } from "./browser";

declare global { interface Window { send: typeof send; receive: typeof receive } }

const directory = await mkdtemp(join(tmpdir(), "voice-compatibility-"));
const worker = "node_modules/mediasoup/worker/out/Release/mediasoup-worker";
try {
  const bundle = await Bun.build({ entrypoints: ["tests/compatibility/browser.ts"], target: "browser", format: "iife" });
  const executable = join(directory, "probe");
  const build = Bun.spawnSync([process.execPath, "build", "./tests/compatibility/server.ts", "--compile",
    "--asset", worker, "--asset", "./src/database/migrations", "--define", `WORKER=${JSON.stringify({ path: `/$bunfs/root/mediasoup-worker`, sha256: sha256(await Bun.file(worker).bytes()), version })}`,
    "--outfile", executable], { stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("Compatibility build failed");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    for (const mode of ["source", "compiled"]) {
      const server = Bun.spawn(mode === "source" ? [process.execPath, import.meta.resolve("./server.ts").slice(7)] : [executable], {
        cwd: directory, stdout: "pipe", stderr: "inherit",
      });
      try {
        const output = server.stdout.getReader();
        const response = await Promise.race([output.read(), Bun.sleep(8000).then(() => { throw new Error("Worker startup timed out"); })]);
        output.releaseLock();
        const url = new TextDecoder().decode(response.value).trim();
        const probe = await (await fetch(new URL("probe", url))).json() as { workerPid: number; sqlite: { value: string } };
        if (probe.sqlite.value !== "sqlite works") throw new Error("SQLite probe failed");
        const a = await browser.newPage();
        const b = await browser.newPage();
        await Promise.all([a, b].map(async (page) => {
          await page.goto(url);
          await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
        }));
        const producer = await a.evaluate(() => window.send());
        const result = await b.evaluate((id) => window.receive(id), producer);
        await Promise.all([a.close(), b.close()]);
        server.kill();
        if (await server.exited !== 0) throw new Error("Ungraceful shutdown");
        try {
          process.kill(probe.workerPid, 0);
          throw new Error("Worker remained alive after shutdown");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        console.log(mode, probe, result);
      } finally { server.kill(); await server.exited; }
    }
  } finally { await browser.close(); }
} finally { await rm(directory, { recursive: true, force: true }); }
