import { chromium, type Page } from "playwright";
import { fixture } from "../server";
import type { harness } from "./browser";

declare global { interface Window { harness: typeof harness } }
type Diagnostics = {
  memory: { rss: number }; cpu: { user: number; system: number };
  workers: { pid: number; usage: { ru_utime: number; ru_stime: number } }[];
};
type RtcCounters = { bytesReceived: number; bytesSent: number };
const [binary, ...sizes] = process.argv.slice(2);
const participants = sizes.length ? sizes.map(Number) : [4, 16];
const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/browser.ts"], target: "browser", format: "iife" });
const script = await bundle.outputs[0]!.text();
for (const users of participants) {
  if (!Number.isSafeInteger(users) || users < 2 || users > 32) throw new Error("Use 2–32 participants");
  const server = await fixture({ binary, environment: { VOICE_LIMITS_UPGRADES_PER_MINUTE: "120" } });
  try {
    const info = await server.call<{ fingerprint: string }>("/api/v1/server/info");
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
      args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors-spki-list=" + info.payload.fingerprint.slice(7)] });
    try {
      const admin = await server.ws(await server.owner());
      const diag = () => admin.rpc<Diagnostics>("admin.diagnostics");
      const pages: Page[] = [];
      for (let current = 0; current < users; current++) {
        const page = await browser.newPage();
        pages.push(page);
        await page.goto(server.origin + "/api/v1/server/info");
        await page.addScriptTag({ content: script });
        await page.evaluate((index) => window.harness.initialize("Benchmark " + index), current);
      }
      const [talker, ...receivers] = pages;
      const setupStart = performance.now();
      const producer = await talker!.evaluate(() => window.harness.publish(false));
      const latency = await Promise.all(receivers.map(async (page) => {
        await page.evaluate((id) => window.harness.consume(id, false), producer);
        return performance.now() - setupStart;
      }));
      const counters = () => Promise.all(pages.map((page) => page.evaluate(() => window.harness.counters()) as Promise<RtcCounters>));
      const [before, startStats] = await Promise.all([diag(), counters()]);
      const sampleStart = performance.now();
      await Bun.sleep(5000);
      const [after, endStats] = await Promise.all([diag(), counters()]);
      const seconds = (performance.now() - sampleStart) / 1000;
      const mebibytes = (bytes: number) => +(bytes / 1048576).toFixed(1);
      const cpu = (row: Diagnostics) => row.cpu.user + row.cpu.system;
      const workerCpu = (row: Diagnostics) => row.workers.reduce((sum, { usage }) => sum + usage.ru_utime + usage.ru_stime, 0);
      const workerStatus = await Bun.file(`/proc/${after.workers[0]!.pid}/status`).text();
      const workerRss = Number(workerStatus.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
      const bandwidth = (direction: keyof RtcCounters) => (endStats.reduce((sum, row, i) =>
        sum + row[direction] - startStats[i]![direction], 0) * 8 / 1000 / seconds).toFixed(1);
      const ordered = latency.sort((a, b) => a - b);
      console.log(JSON.stringify({ users, seconds: +seconds.toFixed(2), mainRssMiB: mebibytes(after.memory.rss),
        workerRssMiB: mebibytes(workerRss), mainCpuPctSingleCore: +((cpu(after) - cpu(before)) / (seconds * 10000)).toFixed(2),
        workerCpuPctSingleCore: +((workerCpu(after) - workerCpu(before)) / (seconds * 10)).toFixed(2),
        workerRxKbps: Number(bandwidth("bytesReceived")), workerTxKbps: Number(bandwidth("bytesSent")),
        medianSetupToDecodedMs: Math.round(ordered[Math.floor(ordered.length / 2)]!), maxSetupToDecodedMs: Math.round(ordered.at(-1)!) }));
      admin.close();
    } finally { await browser.close(); }
  } finally { await server.cleanup(); }
}
