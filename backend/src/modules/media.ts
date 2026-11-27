import type { AudioLevelObserver, Consumer, DtlsParameters, Producer, Router, RtpCapabilities, TransportListenInfo,
  WebRtcServer, WebRtcTransport, Worker } from "mediasoup/types";
import type { Config } from "../config";
import { maxScreenVideoBitrate, type Request } from "../protocol";
import { fail, ProtocolError } from "../security/errors";

type MediaRequest = Extract<Request, { type: `media.${string}` }>;
type Peer = { id: string; channelId: string | null; membershipEpoch: number; account: { id: string; displayName: string } | null };
type Slot = { index: number; worker: Worker | null; server: WebRtcServer | null; rooms: number; restart?: ReturnType<typeof setTimeout> };
type Room = { slot: Slot; pending: Promise<{ router: Router; observer: AudioLevelObserver }>; closed: boolean;
  producers: Map<string, { producer: Producer; peerId: string; accountId: string }>; speaking: Set<string> };
type Kind = "audio" | "video";
export type VideoSource = "screen" | "camera";
type SendSource = "audio" | VideoSource;
export type WhisperRoute = { channelId: string; passwordHash: string | null };
type Transport = { rtc: WebRtcTransport; direction: "send" | "receive"; kind: Kind; videoSource?: VideoSource; whisper?: WhisperRoute; screenNumber?: number };
type Resources = { transports: Map<string, Transport>; producers: Map<string, Producer>; consumers: Map<string, Consumer> };
const maxCameraVideoBitrate = 6000000;

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
      pending: slot.worker.createRouter({ mediaCodecs: [
        { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 } },
        { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
      ] }).then(async (router) => {
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
      .filter((id) => room.speaking.has(id) !== next.has(id)).map((id) => {
        const entry = room.producers.get(id);
        return entry?.producer.appData.whisperFrom === undefined ? entry?.peerId : undefined;
      }));
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
  stopSending(peerId: string, kind?: Kind) {
    const resources = this.resources.get(peerId);
    if (!resources) return;
    if (!kind || kind === "audio") {
      for (const { rtc, whisper } of resources.transports.values()) if (whisper) rtc.close();
    }
    for (const producer of resources.producers.values()) {
      if (!kind || (producer.kind === kind && !producer.appData.videoSource)) producer.close();
    }
  }
  stopReceiving(peerId: string) { for (const consumer of this.resources.get(peerId)?.consumers.values() ?? []) consumer.close(); }

  recheckWhispers(peerId: string, allowed: (whisper: WhisperRoute) => boolean) {
    for (const { rtc, whisper } of this.resources.get(peerId)?.transports.values() ?? []) {
      if (whisper && !allowed(whisper)) rtc.close();
    }
  }

  recheckVideo(peerId: string, allowed: (source: VideoSource) => boolean) {
    for (const { rtc, direction, videoSource } of this.resources.get(peerId)?.transports.values() ?? []) {
      if (direction === "send" && videoSource && !allowed(videoSource)) rtc.close();
    }
  }

  whispers(channelId: string) {
    return [...(this.rooms.get(channelId)?.producers.values() ?? [])].flatMap(({ producer }) => {
      const from = producer.appData.whisperFrom;
      return typeof from === "string" ? [{ producerId: producer.id, from }] : [];
    });
  }

  screens(channelId: string) {
    const producers = [...(this.rooms.get(channelId)?.producers.values() ?? [])];
    const audio = new Map(producers.filter(({ producer }) => producer.kind === "audio" && producer.appData.videoSource === "screen")
      .map(({ producer }) => [producer.appData.transportId, producer.id]));
    return producers
      .filter(({ producer }) => producer.kind === "video" && producer.appData.videoSource === "screen")
      .map(({ producer, peerId }) => ({
        producerId: producer.id, connectionId: peerId, audioProducerId: audio.get(producer.appData.transportId),
        screenNumber: producer.appData.screenNumber,
      }));
  }

  private announceScreen(channelId: string, transportId: string) {
    const video = [...(this.rooms.get(channelId)?.producers.values() ?? [])]
      .find(({ producer }) => producer.kind === "video" && producer.appData.transportId === transportId);
    const share = video && this.screens(channelId).find(({ producerId }) => producerId === video.producer.id);
    if (share) this.event(channelId, "media.screenAvailable", { channelId, ...share });
  }

  cameras(channelId: string) {
    return [...(this.rooms.get(channelId)?.producers.values() ?? [])]
      .filter(({ producer }) => producer.appData.videoSource === "camera")
      .map(({ producer, peerId }) => ({ producerId: producer.id, connectionId: peerId }));
  }

  async handle(peer: Peer, request: MediaRequest, authorize: (send?: SendSource, receive?: boolean) => void,
    authorizeWhisper: (whisper: WhisperRoute) => boolean, requestedWhisper?: WhisperRoute) {
    authorize();
    const sourceChannelId = peer.channelId ?? fail("FORBIDDEN");
    const epoch = peer.membershipEpoch;
    const current = this.resources.get(peer.id);
    const { payload } = request;
    const whisperTransport = "transportId" in payload ? current?.transports.get(payload.transportId)?.whisper : undefined;
    const whisperProducer = "producerId" in payload ? current?.producers.get(payload.producerId)?.appData.whisper as WhisperRoute | undefined : undefined;
    const whisper = requestedWhisper ?? whisperTransport ?? whisperProducer;
    const closing = request.type === "media.transport.close" || request.type === "media.producer.close";
    const channelId = whisper?.channelId ?? sourceChannelId;
    const room = whisper && !requestedWhisper ? this.rooms.get(channelId) ?? fail("NOT_FOUND") : this.room(channelId);
    const { router, observer } = await room.pending.catch((error) => {
      if (error instanceof ProtocolError) throw error;
      fail("UNAVAILABLE");
    });
    const ensureCurrent = (send?: SendSource, receive?: boolean) => {
      authorize(whisper && !closing ? "audio" : send, receive);
      if (peer.membershipEpoch !== epoch || peer.channelId !== sourceChannelId || room.closed) fail("CONFLICT");
      if (whisper && !closing && !authorizeWhisper(whisper)) fail("FORBIDDEN");
    };
    ensureCurrent();
    let state = this.resources.get(peer.id);
    if (!state) {
      state = { transports: new Map(), producers: new Map(), consumers: new Map() };
      this.resources.set(peer.id, state);
    }
    const resources = state;
    const transport = (id: string, direction?: Transport["direction"], kind?: Kind, videoSource?: VideoSource) => {
      const entry = resources.transports.get(id);
      if (!entry || (direction && entry.direction !== direction) || (kind && entry.kind !== kind)) fail("NOT_FOUND");
      if (videoSource && entry.videoSource !== videoSource) fail("NOT_FOUND");
      return entry.rtc;
    };
    const producer = (id: string) => resources.producers.get(id) ?? fail("NOT_FOUND");
    const consumer = (id: string) => resources.consumers.get(id) ?? fail("NOT_FOUND");
    try {
      switch (request.type) {
        case "media.capabilities": {
          const { codecs, headerExtensions } = router.rtpCapabilities;
          if (request.payload.kind === "video") return { codecs, headerExtensions, iceServers: this.config.media.ice_servers };
          return { codecs: codecs?.filter((codec) => codec.kind === "audio"), headerExtensions };
        }
        case "media.producers":
          return [...room.producers].filter(([, entry]) => entry.peerId !== peer.id && !entry.producer.appData.videoSource).map(([id, entry]) =>
            ({ producerId: id, connectionId: entry.peerId, paused: entry.producer.paused, speaking: room.speaking.has(id) }));
        case "media.transport.create": {
          const { direction, forceTcp, kind = "audio" } = request.payload;
          if (request.payload.videoSource && kind !== "video") fail("INVALID_REQUEST");
          const videoSource = kind === "video" ? request.payload.videoSource ?? "screen" : undefined;
          if (forceTcp && !this.config.media.enable_tcp) fail("INVALID_REQUEST");
          const existing = [...resources.transports.values()];
          if (kind === "audio" && direction === "send" && existing.some((entry) =>
            entry.kind === "audio" && entry.direction === "send" && (whisper || entry.whisper))) fail("CONFLICT");
          const checkVideoLimit = () => {
            const limit = videoSource === "screen" && direction === "send" ? this.config.limits.transports : 1;
            if ([...resources.transports.values()].filter((entry) => entry.videoSource === videoSource &&
                entry.direction === direction).length >= limit) fail("LIMIT");
          };
          if (kind === "video") {
            ensureCurrent(direction === "send" ? videoSource : undefined, direction === "receive");
            checkVideoLimit();
          } else if (existing.filter((entry) => entry.kind === kind).length >= this.config.limits.transports) fail("LIMIT");
          const rtc = await router.createWebRtcTransport({
            webRtcServer: room.slot.server ?? fail("UNAVAILABLE"),
            enableUdp: this.config.media.enable_udp && !forceTcp, enableTcp: this.config.media.enable_tcp,
            preferUdp: !forceTcp, enableSctp: false,
          });
          try {
            if (videoSource && direction === "send") {
              await rtc.setMaxIncomingBitrate(videoSource === "camera" ? maxCameraVideoBitrate : maxScreenVideoBitrate + 320000);
            }
            ensureCurrent(direction === "send" ? videoSource : undefined, kind === "video" && direction === "receive");
            if (videoSource) checkVideoLimit();
          } catch (error) { rtc.close(); throw error; }
          let screenNumber: number | undefined;
          if (videoSource === "screen" && direction === "send") {
            const used = new Set([...resources.transports.values()].map((entry) => entry.screenNumber));
            screenNumber = 1;
            while (used.has(screenNumber)) screenNumber++;
          }
          resources.transports.set(rtc.id, { rtc, direction, kind, videoSource, whisper, screenNumber });
          let iceTimer: ReturnType<typeof setTimeout> | undefined;
          rtc.observer.once("close", () => {
            clearTimeout(iceTimer);
            resources.transports.delete(rtc.id);
            if (whisper) this.peerEvent(peer.id, "media.whisperEnded", { channelId: sourceChannelId, transportId: rtc.id });
          });
          const failure = (reason: string) => {
            if (rtc.closed) return;
            rtc.close();
            if (whisper) return;
            const event = videoSource === "camera" ? "media.cameraTransportFailed"
              : videoSource === "screen" ? "media.screenTransportFailed" : "media.transportFailed";
            this.peerEvent(peer.id, event, { channelId, transportId: rtc.id, reason });
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
          const { kind, rtpParameters, transportId } = request.payload;
          const { videoSource, screenNumber } = resources.transports.get(transportId) ?? {};
          if (rtpParameters.codecs.some(({ mimeType }) => !mimeType.toLowerCase().startsWith(kind + "/"))) fail("INVALID_REQUEST");
          const checkLimit = () => {
            const matching = [...resources.producers.values()].filter((entry) => entry.kind === kind &&
              entry.appData.videoSource === videoSource && (videoSource !== "screen" || entry.appData.transportId === transportId));
            if (matching.length >= (videoSource ? 1 : this.config.limits.producers)) fail("LIMIT");
          };
          checkLimit();
          const rtc = transport(transportId, "send", videoSource ? "video" : "audio", videoSource);
          if (videoSource !== "screen" && kind !== (videoSource ? "video" : "audio")) fail("INVALID_REQUEST");
          ensureCurrent(videoSource ?? "audio");
          if (videoSource === "camera" && rtpParameters.encodings?.some(({ maxBitrate }) => (maxBitrate ?? 0) > maxCameraVideoBitrate)) fail("INVALID_REQUEST");
          const whisperFrom = whisper ? peer.account!.displayName : undefined;
          const entry = await rtc.produce({ kind, rtpParameters, appData: { videoSource, transportId, screenNumber, whisper, whisperFrom } });
          try {
            ensureCurrent(videoSource ?? "audio");
            if (entry.closed || rtc.closed) fail("NOT_FOUND");
            checkLimit();
          } catch (error) { entry.close(); throw error; }
          resources.producers.set(entry.id, entry);
          room.producers.set(entry.id, { producer: entry, peerId: peer.id, accountId: peer.account!.id });
          entry.observer.once("close", () => {
            resources.producers.delete(entry.id);
            room.producers.delete(entry.id);
            if (room.speaking.delete(entry.id) && !whisper) this.event(channelId, "channel.voiceActivity",
              { channelId, connectionId: peer.id, speaking: this.isSpeaking(channelId, peer.id) });
            if (videoSource === "camera") {
              this.event(channelId, "media.cameraClosed", { channelId, producerId: entry.id });
            } else if (kind === "video") {
              for (const producer of resources.producers.values()) {
                if (producer.kind === "audio" && producer.appData.transportId === transportId) producer.close();
              }
              this.event(channelId, "media.screenClosed", { channelId, producerId: entry.id });
            } else if (videoSource === "screen") {
              if (!rtc.closed) this.announceScreen(channelId, transportId);
            } else this.event(channelId, "media.producerClosed", { channelId, producerId: entry.id });
          });
          if (videoSource === "camera") {
            this.event(channelId, "media.cameraAvailable", { channelId, producerId: entry.id, connectionId: peer.id });
          } else if (videoSource === "screen") {
            this.announceScreen(channelId, transportId);
          } else {
            void observer.addProducer({ producerId: entry.id }).catch(() => {});
            this.event(channelId, "media.producerAvailable", { channelId, producerId: entry.id, connectionId: peer.id, whisperFrom });
          }
          return { id: entry.id };
        }
        case "media.producer.pause": {
          const entry = producer(request.payload.producerId);
          await entry.pause();
          if (!entry.appData.videoSource) this.event(channelId, "media.producerState", { producerId: entry.id, paused: true });
          break;
        }
        case "media.producer.resume": {
          const entry = producer(request.payload.producerId);
          const purpose = (entry.appData.videoSource as VideoSource | undefined) ?? "audio";
          ensureCurrent(purpose);
          await entry.resume();
          try { ensureCurrent(purpose); } catch (error) { entry.close(); throw error; }
          if (!entry.appData.videoSource) this.event(channelId, "media.producerState", { producerId: entry.id, paused: false });
          break;
        }
        case "media.producer.close": producer(request.payload.producerId).close(); break;
        case "media.consumer.create": {
          ensureCurrent(undefined, true);
          const { producerId } = request.payload;
          const { codecs, headerExtensions } = request.payload.rtpCapabilities;
          const sender = room.producers.get(producerId);
          if (!sender || sender.peerId === peer.id) fail("NOT_FOUND");
          const kind = sender.producer.kind;
          const videoSource = sender.producer.appData.videoSource as VideoSource | undefined;
          const rtpCapabilities: RtpCapabilities = { codecs: codecs.filter((codec) => codec.kind === kind),
            headerExtensions: headerExtensions?.filter((entry) => entry.kind === kind) };
          if (!router.canConsume({ producerId, rtpCapabilities })) fail("NOT_FOUND");
          const checkLimit = () => {
            const consumers = [...resources.consumers.values()];
            if (consumers.some((entry) => entry.producerId === producerId)) fail("LIMIT");
            const matching = consumers.filter((entry) => entry.kind === kind && entry.appData.videoSource === videoSource);
            if (matching.length >= (videoSource === "camera" ? 1 : this.config.limits.consumers)) fail("LIMIT");
          };
          checkLimit();
          const entry = await transport(request.payload.transportId, "receive", videoSource ? "video" : "audio", videoSource).consume({
            producerId, rtpCapabilities, paused: true, appData: { videoSource },
          });
          try {
            ensureCurrent(undefined, true);
            if (entry.closed || !room.producers.has(producerId)) fail("NOT_FOUND");
            checkLimit();
          } catch (error) { entry.close(); throw error; }
          resources.consumers.set(entry.id, entry);
          entry.observer.once("close", () => resources.consumers.delete(entry.id));
          if (!videoSource) entry.once("producerclose", () => this.peerEvent(peer.id, "media.consumerClosed", { consumerId: entry.id, producerId }));
          const { id, rtpParameters, producerPaused } = entry;
          return { id, producerId, kind, rtpParameters, producerPaused, accountId: sender.accountId };
        }
        case "media.consumer.pause": await consumer(request.payload.consumerId).pause(); break;
        case "media.consumer.resume": {
          ensureCurrent(undefined, true);
          const entry = consumer(request.payload.consumerId);
          await entry.resume();
          try { ensureCurrent(undefined, true); } catch (error) { entry.close(); throw error; }
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
