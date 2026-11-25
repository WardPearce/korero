import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/database";
import { metadata } from "../../src/database/schema";
import { Elysia } from "elysia";
import type { Producer, WebRtcTransport } from "mediasoup/types";
import { extractWorker } from "../../src/security/files";

declare const WORKER: { path: string; sha256: string; version: string } | undefined;
if (typeof WORKER !== "undefined" && WORKER) {
  await extractWorker(process.cwd(), WORKER.version, await Bun.file(WORKER.path).bytes(), WORKER.sha256);
}
const { createWorker, version } = await import("mediasoup");
const worker = await createWorker();
const server = await worker.createWebRtcServer({
  listenInfos: ["udp", "tcp"].map((protocol) => ({ protocol: protocol as "udp" | "tcp", ip: "127.0.0.1", port: Number(process.env.POC_MEDIA_PORT ?? 18444) })),
});
const router = await worker.createRouter({ mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }] });
const db = openDatabase(process.cwd());
db.insert(metadata).values({ key: "compatibility", value: "sqlite works" }).onConflictDoNothing().run();
const transports = new Map<string, WebRtcTransport>();
const producers = new Map<string, Producer>();
const app = new Elysia().get("/", () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
  .get("/probe", async () => ({ sqlite: db.select({ value: metadata.value }).from(metadata).where(eq(metadata.key, "compatibility")).get(), version, workerPid: worker.pid, resources: await worker.getResourceUsage() }))
  .ws("/ws", {
    async message(ws, data) {
      const { id, method, args } = data as { id: number; method: string; args: any };
      try {
        const transport = transports.get(args.transportId);
        let result: unknown;
        switch (method) {
          case "router": result = router.rtpCapabilities; break;
          case "transport": {
            const rtc = await router.createWebRtcTransport({ webRtcServer: server });
            transports.set(rtc.id, rtc);
            const { id, iceParameters, iceCandidates, dtlsParameters } = rtc;
            result = { id, iceParameters, iceCandidates, dtlsParameters };
            break;
          }
          case "connect": result = await transport!.connect({ dtlsParameters: args.dtlsParameters }); break;
          case "produce": {
            const producer = await transport!.produce({ kind: "audio", rtpParameters: args.rtpParameters });
            producers.set(producer.id, producer);
            result = { id: producer.id };
            break;
          }
          case "consume": {
            const { id, producerId, kind, rtpParameters } = await transport!.consume({ producerId: producers.get(args.producerId)!.id, rtpCapabilities: args.rtpCapabilities });
            result = { id, producerId, kind, rtpParameters };
            break;
          }
          default: throw new Error("unknown method");
        }
        ws.send({ id, result });
      } catch (error) { ws.send({ id, error: String(error) }); }
    },
  }).listen({ hostname: "127.0.0.1", port: Number(process.env.POC_PORT ?? 18443) });
worker.on("died", () => process.exit(1));
console.log(app.server!.url.href);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, async () => {
  await app.stop(true);
  const closed = new Promise<void>((resolve) => worker.once("subprocessclose", resolve));
  worker.close();
  await closed;
  db.$client.close();
});
