import type { AudioLevelObserver, Consumer, DtlsParameters, Producer, Router, RtpCapabilities, TransportListenInfo,
  WebRtcServer, WebRtcTransport, Worker } from "mediasoup/types";
import type { Config } from "../config";
import type { Request } from "../protocol";
import { fail, ProtocolError } from "../security/errors";

type MediaRequest = Extract<Request, { type: `media.${string}` }>;
type Peer = { id: string; channelId: string | null; membershipEpoch: number; muted: boolean; adminMuted: boolean; deafened: boolean };
type Slot = { index: number; worker: Worker | null; server: WebRtcServer | null; rooms: number; restart?: ReturnType<typeof setTimeout> };
type Room = { slot: Slot; pending: Promise<{ router: Router; observer: AudioLevelObserver }>; closed: boolean;
  producers: Map<string, { producer: Producer; peerId: string }>; speaking: Set<string> };
type Transport = { rtc: WebRtcTransport; direction: "send" | "receive" };
type Resources = { transports: Map<string, Transport>; producers: Map<string, Producer>; consumers: Map<string, Consumer> };

export class Media {
  private readonly rooms = new Map<string, Room>();
  private readonly resources = new Map<string, Resources>();
  private readonly slots: Slot[];
  private readonly starting = new Set<Promise<void>>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;
  event: (channelId: string, type: string, payload: unknown) => void = () => {};
  peerEvent: (peerId: string, type: string, payload: unknown) => void = () => {};
  constructor(private readonly config: Config) {
    this.slots = Array.from({ length: config.media.workers }, (_, index) => ({ index, worker: null, server: null, rooms: 0 }));
  }

  get ready() { return !this.closed && this.slots.every((slot) => slot.server !== null); }
  async start() {
    try { for (const slot of this.slots) await this.startSlot(slot); }
    catch (error) { await this.close(); throw error; }
  }
  private async startSlot(slot: Slot) {
    const { createWorker } = await import("mediasoup");
    const worker = await createWorker({ logLevel: "error" });
    const { media, mediaAddresses } = this.config;
    const protocols: Array<"udp" | "tcp"> = [];
    if (media.enable_udp) protocols.push("udp");
    if (media.enable_tcp) protocols.push("tcp");
    const listenInfos: TransportListenInfo[] = mediaAddresses.flatMap(({ ip, announcedAddress }) =>
      protocols.map((protocol) => ({ protocol, ip, announcedAddress, port: media.port + slot.index,
        flags: { ipv6Only: true } })));
    try {
      const server = await worker.createWebRtcServer({ listenInfos });
      if (this.closed || worker.closed) throw new Error("Media worker stopped during initialization");
      slot.worker = worker;
      slot.server = server;
      worker.once("died", () => {
        this.stopWorker(worker);
        slot.worker = null;
        slot.server = null;
        for (const [channelId, room] of this.rooms) {
          if (room.slot !== slot) continue;
          this.releaseRoom(channelId);
          this.event(channelId, "media.reset", { channelId, reason: "workerExited" });
        }
        console.error(`Media worker ${slot.index + 1} exited`);
        this.scheduleRestart(slot);
      });
    } catch (error) {
      this.stopWorker(worker);
      throw error;
    }
  }
  private scheduleRestart(slot: Slot) {
    if (this.closed) return;
    slot.restart = setTimeout(() => {
      slot.restart = undefined;
      const task = this.startSlot(slot).catch(() => this.scheduleRestart(slot));
      this.starting.add(task);
      void task.finally(() => this.starting.delete(task));
    }, 1000);
  }
  private stopWorker(worker: Worker) {
    if (worker.subprocessClosed) return;
    const stopped = new Promise<void>((resolve) => worker.once("subprocessclose", resolve));
    this.stopping.add(stopped);
    void stopped.finally(() => this.stopping.delete(stopped));
    worker.close();
  }

  private room(channelId: string) {
    const current = this.rooms.get(channelId);
    if (current) return current;
    const slot = this.slots.filter((candidate) => candidate.server && candidate.worker).sort((a, b) => a.rooms - b.rooms)[0];
    if (!slot?.worker) fail("UNAVAILABLE");
    slot.rooms++;
    const room: Room = {
      slot, closed: false, producers: new Map(), speaking: new Set(),
      pending: slot.worker.createRouter({ mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000,
        channels: 2, parameters: { useinbandfec: 1 } }] }).then(async (router) => {
        try {
          if (room.closed) fail("CONFLICT");
          const observer = await router.createAudioLevelObserver({ maxEntries: 8, threshold: -55, interval: 300 });
          if (room.closed) fail("CONFLICT");
          observer.on("volumes", (entries) => this.speaking(channelId, room, new Set(entries.map(({ producer }) => producer.id))));
          observer.on("silence", () => this.speaking(channelId, room, new Set()));
          return { router, observer };
        } catch (error) { router.close(); throw error; }
      }),
    };
    this.rooms.set(channelId, room);
    void room.pending.catch(() => {
      if (this.rooms.get(channelId) === room) this.releaseRoom(channelId);
    });
    return room;
  }
  isSpeaking(channelId: string, connectionId: string) {
    const room = this.rooms.get(channelId);
    return !!room && [...room.speaking].some((id) => room.producers.get(id)?.peerId === connectionId);
  }

  private speaking(channelId: string, room: Room, next: Set<string>) {
    if (room.closed) return;
    for (const id of room.speaking) if (!next.has(id)) this.event(channelId, "media.speaking", { producerId: id, speaking: false });
    for (const id of next) if (room.producers.has(id) && !room.speaking.has(id)) this.event(channelId, "media.speaking", { producerId: id, speaking: true });
    const changed = new Set([...room.speaking, ...next]
      .filter((id) => room.speaking.has(id) !== next.has(id)).map((id) => room.producers.get(id)?.peerId));
    room.speaking = new Set([...next].filter((id) => room.producers.has(id)));
    for (const connectionId of changed) if (connectionId)
      this.event(channelId, "channel.voiceActivity", { channelId, connectionId, speaking: this.isSpeaking(channelId, connectionId) });
  }

  releaseRoom(channelId: string) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    this.rooms.delete(channelId);
    room.closed = true;
    room.slot.rooms--;
    void room.pending.then(({ router }) => router.close(), () => {});
  }
  detach(peerId: string) {
    const resources = this.resources.get(peerId);
    this.resources.delete(peerId);
    if (resources) for (const { rtc } of resources.transports.values()) rtc.close();
  }
  stopSending(peerId: string) { for (const producer of this.resources.get(peerId)?.producers.values() ?? []) producer.close(); }
  stopReceiving(peerId: string) { for (const consumer of this.resources.get(peerId)?.consumers.values() ?? []) consumer.close(); }

  async handle(peer: Peer, request: MediaRequest, authorize: (send?: boolean, receive?: boolean) => void) {
    authorize();
    const channelId = peer.channelId ?? fail("FORBIDDEN");
    const epoch = peer.membershipEpoch;
    const room = this.room(channelId);
    const { router, observer } = await room.pending.catch((error) => {
      if (error instanceof ProtocolError) throw error;
      fail("UNAVAILABLE");
    });
    const ensureCurrent = (send?: boolean, receive?: boolean) => {
      authorize(send, receive);
      if (peer.membershipEpoch !== epoch || peer.channelId !== channelId || room.closed) fail("CONFLICT");
    };
    ensureCurrent();
    let state = this.resources.get(peer.id);
    if (!state) {
      state = { transports: new Map(), producers: new Map(), consumers: new Map() };
      this.resources.set(peer.id, state);
    }
    const resources = state;
    const transport = (id: string, direction?: Transport["direction"]) => {
      const entry = resources.transports.get(id);
      if (!entry || (direction && entry.direction !== direction)) fail("NOT_FOUND");
      return entry.rtc;
    };
    const producer = (id: string) => resources.producers.get(id) ?? fail("NOT_FOUND");
    const consumer = (id: string) => resources.consumers.get(id) ?? fail("NOT_FOUND");
    try {
      switch (request.type) {
        case "media.capabilities": return router.rtpCapabilities;
        case "media.producers":
          return [...room.producers].filter(([, entry]) => entry.peerId !== peer.id).map(([id, entry]) =>
            ({ producerId: id, connectionId: entry.peerId, paused: entry.producer.paused, speaking: room.speaking.has(id) }));
        case "media.transport.create": {
          const { direction, forceTcp } = request.payload;
          if (forceTcp && !this.config.media.enable_tcp) fail("INVALID_REQUEST");
          if (resources.transports.size >= this.config.limits.transports) fail("LIMIT");
          const rtc = await router.createWebRtcTransport({
            webRtcServer: room.slot.server ?? fail("UNAVAILABLE"),
            enableUdp: this.config.media.enable_udp && !forceTcp, enableTcp: this.config.media.enable_tcp,
            preferUdp: !forceTcp, enableSctp: false,
          });
          try { ensureCurrent(); } catch (error) { rtc.close(); throw error; }
          resources.transports.set(rtc.id, { rtc, direction });
          let iceTimer: ReturnType<typeof setTimeout> | undefined;
          rtc.observer.once("close", () => { clearTimeout(iceTimer); resources.transports.delete(rtc.id); });
          const failure = (reason: string) => {
            if (rtc.closed) return;
            rtc.close();
            this.peerEvent(peer.id, "media.transportFailed", { transportId: rtc.id, reason });
          };
          rtc.on("dtlsstatechange", (status) => { if (status === "failed" || status === "closed") failure(status); });
          rtc.on("icestatechange", (status) => {
            clearTimeout(iceTimer);
            if (status === "disconnected") {
              this.peerEvent(peer.id, "media.transportState", { transportId: rtc.id, state: status });
              iceTimer = setTimeout(() => failure("iceTimeout"), 20000);
            } else if (status === "closed") failure(status);
          });
          const { id, iceCandidates, iceParameters, dtlsParameters } = rtc;
          return { id, iceCandidates, iceParameters, dtlsParameters };
        }
        case "media.transport.connect": {
          const { dtlsParameters } = request.payload;
          const lengths = { "sha-1": 20, "sha-224": 28, "sha-256": 32, "sha-384": 48, "sha-512": 64 };
          if (dtlsParameters.fingerprints.some(({ algorithm, value }) => value.split(":").length !== lengths[algorithm])) fail("INVALID_REQUEST");
          await transport(request.payload.transportId).connect({ dtlsParameters: dtlsParameters as DtlsParameters });
          break;
        }
        case "media.transport.close": transport(request.payload.transportId).close(); break;
        case "media.transport.stats": return await transport(request.payload.transportId).getStats();
        case "media.ice.restart": return await transport(request.payload.transportId).restartIce();
        case "media.producer.create": {
          ensureCurrent(true);
          if (resources.producers.size >= this.config.limits.producers) fail("LIMIT");
          const entry = await transport(request.payload.transportId, "send").produce({ kind: "audio", rtpParameters: request.payload.rtpParameters });
          try { ensureCurrent(true); } catch (error) { entry.close(); throw error; }
          resources.producers.set(entry.id, entry);
          room.producers.set(entry.id, { producer: entry, peerId: peer.id });
          entry.observer.once("close", () => {
            resources.producers.delete(entry.id);
            room.producers.delete(entry.id);
            if (room.speaking.delete(entry.id)) this.event(channelId, "channel.voiceActivity",
              { channelId, connectionId: peer.id, speaking: this.isSpeaking(channelId, peer.id) });
            this.event(channelId, "media.producerClosed", { channelId, producerId: entry.id });
          });
          void observer.addProducer({ producerId: entry.id }).catch(() => {});
          this.event(channelId, "media.producerAvailable", { channelId, producerId: entry.id, connectionId: peer.id });
          return { id: entry.id };
        }
        case "media.producer.pause": {
          const entry = producer(request.payload.producerId);
          await entry.pause();
          this.event(channelId, "media.producerState", { producerId: entry.id, paused: true });
          break;
        }
        case "media.producer.resume": {
          ensureCurrent(true);
          const entry = producer(request.payload.producerId);
          await entry.resume();
          try { ensureCurrent(true); } catch (error) { entry.close(); throw error; }
          this.event(channelId, "media.producerState", { producerId: entry.id, paused: false });
          break;
        }
        case "media.producer.close": producer(request.payload.producerId).close(); break;
        case "media.consumer.create": {
          ensureCurrent(false, true);
          if (resources.consumers.size >= this.config.limits.consumers) fail("LIMIT");
          const { producerId } = request.payload;
          const { codecs, headerExtensions } = request.payload.rtpCapabilities;
          const rtpCapabilities: RtpCapabilities = { codecs, headerExtensions: headerExtensions?.filter((entry) => entry.kind === "audio") };
          const sender = room.producers.get(producerId);
          if (!sender || sender.peerId === peer.id || !router.canConsume({ producerId, rtpCapabilities })) fail("NOT_FOUND");
          const entry = await transport(request.payload.transportId, "receive").consume({
            producerId, rtpCapabilities, paused: true,
          });
          try {
            ensureCurrent(false, true);
            if (entry.closed || !room.producers.has(producerId)) fail("NOT_FOUND");
          } catch (error) { entry.close(); throw error; }
          resources.consumers.set(entry.id, entry);
          entry.observer.once("close", () => resources.consumers.delete(entry.id));
          entry.once("producerclose", () => this.peerEvent(peer.id, "media.consumerClosed", { consumerId: entry.id, producerId }));
          const { id, kind, rtpParameters, producerPaused } = entry;
          return { id, producerId, kind, rtpParameters, producerPaused };
        }
        case "media.consumer.pause": await consumer(request.payload.consumerId).pause(); break;
        case "media.consumer.resume": {
          ensureCurrent(false, true);
          const entry = consumer(request.payload.consumerId);
          await entry.resume();
          try { ensureCurrent(false, true); } catch (error) { entry.close(); throw error; }
          break;
        }
        case "media.consumer.close": consumer(request.payload.consumerId).close(); break;
      }
      ensureCurrent();
      return {};
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (room.closed || router.closed) fail("UNAVAILABLE");
      if (error instanceof TypeError || (error instanceof Error && ["UnsupportedError", "InvalidStateError"].includes(error.name))) fail("INVALID_REQUEST");
      fail("CONFLICT");
    }
  }

  async diagnostics() {
    const totals = { transports: 0, producers: 0, consumers: 0 };
    for (const row of this.resources.values()) {
      totals.transports += row.transports.size;
      totals.producers += row.producers.size;
      totals.consumers += row.consumers.size;
    }
    return { ...totals, routers: this.rooms.size,
      workers: await Promise.all(this.slots.map(async ({ index, worker, rooms }) =>
        ({ index, pid: worker?.pid, rooms, usage: await worker?.getResourceUsage().catch(() => undefined) }))) };
  }
  async close() {
    this.closed = true;
    for (const peerId of this.resources.keys()) this.detach(peerId);
    for (const roomId of this.rooms.keys()) this.releaseRoom(roomId);
    for (const slot of this.slots) {
      clearTimeout(slot.restart);
      if (slot.worker) this.stopWorker(slot.worker);
    }
    await Promise.all(this.starting);
    await Promise.all(this.stopping);
  }
}
