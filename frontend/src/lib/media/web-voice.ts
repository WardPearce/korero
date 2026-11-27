import type { Consumer, ConsumerOptions, RtpCapabilities, Transport, TransportOptions } from "mediasoup-client/types";
import type { Snapshot, VoiceState } from "../connection/client";
import type { MobileCallAudio } from "./mobile-call-audio";
import type { MediaRequest } from "./screen-media";

interface Source {
  producerId: string;
  connectionId: string;
}

interface RemoteAudio {
  consumer: Consumer;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
  accountId: string;
}

export class WebVoice {
  private sendError: string | null = null;
  private receiveError: string | null = null;
  private publishing = false;
  private closed = false;
  private canSend = false;
  private canReceive = false;
  private sendGeneration = 0;
  private receiveGeneration = 0;
  private bitrate = 48000;
  private sender?: Transport;
  private receiver?: Transport;
  private microphone?: MediaStreamTrack;
  private sources = new Set<string>();
  private remote = new Map<string, RemoteAudio>();
  private subscribing = new Set<string>();
  private sourceChanges?: Map<string, boolean>;
  private sending = Promise.resolve();
  private playback = Promise.resolve();
  private device?: ReturnType<WebVoice["load"]>;

  constructor(
    readonly channelId: string,
    private readonly connectionId: string,
    private readonly audio: AudioContext,
    private readonly callAudio: MobileCallAudio,
    private readonly request: MediaRequest,
    private readonly changed: () => void,
    private readonly volumes: Record<string, number>,
  ) {}

  get error() {
    return this.sendError ?? this.receiveError;
  }

  get voice(): VoiceState["voice"] {
    if (this.error) return "error";
    if (!this.canReceive) return "deafened";
    if (!this.canSend) return "muted";
    return this.publishing ? "active" : "idle";
  }

  update(snapshot: Snapshot) {
    const member = snapshot.members.find(({ connectionId }) => connectionId === this.connectionId);
    if (!member) return;
    const { muted, deafened, adminMuted, adminDeafened, afk } = member;
    const receive = !deafened && !adminDeafened && !afk;
    const send = receive && !muted && !adminMuted;
    this.bitrate = snapshot.targetAudioBitrate ?? this.bitrate;
    if (receive !== this.canReceive) {
      this.canReceive = receive;
      if (receive) this.playback = this.callAudio.setMode("playback", () => !this.closed && this.canReceive);
      this.restartReceiving();
    }
    if (send !== this.canSend) {
      this.canSend = send;
      this.restartSending();
      if (!send) this.releaseMicrophoneMode();
    }
  }

  setVolume(accountId: string, level: number) {
    for (const entry of this.remote.values()) {
      if (entry.accountId === accountId) entry.gain.gain.value = level / 100;
    }
  }

  event(type: string, payload: Partial<Source> & { channelId?: string }) {
    if (payload.channelId && payload.channelId !== this.channelId) return;
    if (type === "media.reset") {
      this.device = undefined;
      this.restartReceiving();
      this.restartSending();
      return;
    }
    const { producerId, connectionId } = payload;
    if (!producerId) return;
    if (type === "media.producerAvailable" && connectionId && connectionId !== this.connectionId) {
      this.sourceChanges?.set(producerId, true);
      this.sources.add(producerId);
      void this.subscribe(producerId, this.receiveGeneration);
    } else if (type === "media.producerClosed" || type === "media.consumerClosed") {
      this.sourceChanges?.set(producerId, false);
      this.sources.delete(producerId);
      this.removeRemote(producerId);
    }
  }

  private async load() {
    const { Device } = await import("mediasoup-client");
    const capabilities = await this.request<RtpCapabilities & { iceServers?: RTCIceServer[] }>("media.capabilities", { kind: "video" });
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities: capabilities });
    return { device, iceServers: capabilities.iceServers };
  }

  private async open(direction: "send" | "receive", current: () => boolean) {
    const { device, iceServers } = await (this.device ??= this.load().catch((error) => {
      this.device = undefined;
      throw error;
    }));
    if (!current()) return;
    const options = await this.request<TransportOptions>("media.transport.create", { direction });
    if (!current()) {
      await this.closeServerTransport(options.id);
      return;
    }
    let transport: Transport;
    try {
      transport = direction === "send" ? device.createSendTransport({ ...options, iceServers })
        : device.createRecvTransport({ ...options, iceServers });
    } catch (error) {
      await this.closeServerTransport(options.id);
      throw error;
    }
    transport.on("connect", ({ dtlsParameters }, accept, reject) => {
      void this.request("media.transport.connect", { transportId: transport.id, dtlsParameters })
        .then(() => accept(), reject);
    });
    transport.on("connectionstatechange", (state) => {
      if (!current() || state !== "failed") return;
      const message = "The voice connection failed. Rejoin the channel to try again.";
      if (direction === "send") this.failSending(message);
      else this.failReceiving(message);
    });
    return { device, transport };
  }

  private closeServerTransport(transportId: string) {
    return this.request("media.transport.close", { transportId }).catch(() => {});
  }

  private stopTransport(transport?: Transport) {
    if (!transport) return Promise.resolve();
    transport.close();
    return this.closeServerTransport(transport.id);
  }

  private restartSending() {
    const generation = ++this.sendGeneration;
    const current = () => !this.closed && this.canSend && generation === this.sendGeneration;
    const stopping = this.stopSending();
    this.sendError = null;
    this.sending = this.sending.then(async () => {
      await stopping;
      if (!current()) return;
      await this.playback;
      await this.callAudio.setMode("play-and-record", current);
      if (!current()) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("No microphone is available.");
      if (!current()) {
        track.stop();
        return;
      }
      this.microphone = track;
      const opened = await this.open("send", current);
      if (!opened) return;
      const { transport } = opened;
      this.sender = transport;
      transport.on("produce", ({ kind, rtpParameters }, accept, reject) => {
        void this.request<{ id: string }>("media.producer.create", { transportId: transport.id, kind, rtpParameters })
          .then(accept, reject);
      });
      await transport.produce({
        track,
        codecOptions: { opusDtx: true, opusFec: true, opusStereo: false, opusMaxAverageBitrate: this.bitrate, opusPtime: 20 },
      });
      if (!current()) return;
      this.publishing = true;
      this.changed();
    }).catch((error) => {
      if (current()) this.failSending(error instanceof Error ? error.message : String(error));
    });
  }

  private stopSending() {
    this.microphone?.stop();
    this.microphone = undefined;
    this.publishing = false;
    const stopping = this.stopTransport(this.sender);
    this.sender = undefined;
    return stopping;
  }

  private failSending(message: string) {
    this.sendGeneration++;
    this.sendError = message;
    void this.stopSending();
    this.releaseMicrophoneMode();
    this.changed();
  }

  private releaseMicrophoneMode() {
    void this.callAudio.setMode("playback", () => !this.closed).catch(() => {});
  }

  private restartReceiving() {
    const generation = ++this.receiveGeneration;
    const current = () => this.isReceiving(generation);
    const stopping = this.stopReceiving();
    this.receiveError = null;
    if (!current()) return;
    const changes = new Map<string, boolean>();
    this.sourceChanges = changes;
    void stopping.then(async () => {
      if (!current()) return;
      await this.playback;
      const opened = await this.open("receive", current);
      if (!opened) return;
      this.receiver = opened.transport;
      const producers = await this.request<Source[]>("media.producers", {});
      if (!current()) return;
      this.sources = new Set(producers.map(({ producerId }) => producerId));
      for (const [id, available] of changes) {
        if (available) this.sources.add(id);
        else this.sources.delete(id);
      }
      this.sourceChanges = undefined;
      for (const id of this.sources.keys()) void this.subscribe(id, generation);
    }).catch((error) => {
      if (current()) this.failReceiving(error instanceof Error ? error.message : String(error));
    });
  }

  private stopReceiving() {
    for (const producerId of this.remote.keys()) this.removeRemote(producerId);
    this.subscribing.clear();
    this.sourceChanges = undefined;
    const stopping = this.stopTransport(this.receiver);
    this.receiver = undefined;
    return stopping;
  }

  private failReceiving(message: string) {
    this.receiveGeneration++;
    this.receiveError = message;
    void this.stopReceiving();
    this.changed();
  }

  private isReceiving(generation: number) {
    return !this.closed && this.canReceive && generation === this.receiveGeneration;
  }

  private async subscribe(producerId: string, generation: number) {
    const receiver = this.receiver;
    if (!receiver || !this.isReceiving(generation) || this.remote.has(producerId) || this.subscribing.has(producerId)) return;
    this.subscribing.add(producerId);
    let consumer: Consumer | undefined;
    let consumerId: string | undefined;
    try {
      if (!this.device) return;
      const { device } = await this.device;
      if (!this.isReceiving(generation) || !this.sources.has(producerId)) return;
      const options = await this.request<ConsumerOptions & { accountId: string }>("media.consumer.create", {
        transportId: receiver.id, producerId, rtpCapabilities: device.recvRtpCapabilities,
      });
      consumerId = options.id;
      if (!this.isReceiving(generation) || !this.sources.has(producerId)) return;
      consumer = await receiver.consume(options);
      await this.request("media.consumer.resume", { consumerId: consumer.id });
      if (!this.isReceiving(generation) || !this.sources.has(producerId)) return;
      const node = this.audio.createMediaStreamSource(new MediaStream([consumer.track]));
      const gain = this.audio.createGain();
      gain.gain.value = (this.volumes[options.accountId] ?? 100) / 100;
      node.connect(gain).connect(this.audio.destination);
      this.remote.set(producerId, { consumer, node, gain, accountId: options.accountId });
      consumer = undefined;
      consumerId = undefined;
    } catch {
      // Publishers can leave while a consumer is being negotiated.
    } finally {
      consumer?.close();
      if (consumerId && !receiver.closed) void this.request("media.consumer.close", { consumerId }).catch(() => {});
      if (this.isReceiving(generation)) this.subscribing.delete(producerId);
    }
  }

  private removeRemote(producerId: string) {
    const entry = this.remote.get(producerId);
    if (!entry) return;
    entry.node.disconnect();
    entry.gain.disconnect();
    entry.consumer.close();
    this.remote.delete(producerId);
  }

  close() {
    this.closed = true;
    this.restartSending();
    this.restartReceiving();
    this.sources.clear();
  }
}
