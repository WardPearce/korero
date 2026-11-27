import type { Consumer, ConsumerOptions, Producer, RtpCapabilities, Transport, TransportOptions } from "mediasoup-client/types";
import type { Snapshot, VoiceState } from "../connection/client";
import type { AudioPreferences } from "../preferences";
import { microphoneProcessor, openMicrophone } from "./desktop-audio";
import type { MobileCallAudio } from "./mobile-call-audio";
import type { MediaRequest } from "./screen-media";

interface Source {
  producerId: string;
  connectionId: string;
}

export interface VoiceEvent extends Partial<Source> {
  channelId?: string;
  transportId?: string;
}

interface WhisperRoute {
  targetId: string;
  password?: string;
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
  private producer?: Producer;
  private receiver?: Transport;
  private microphone?: MediaStreamTrack;
  private capture?: { source: MediaStreamAudioSourceNode; processor: AudioWorkletNode; track: MediaStreamTrack };
  private output: GainNode;
  private talking = false;
  private whisperTalking = false;
  private whisper?: WhisperRoute;
  private talkLease?: ReturnType<typeof setInterval>;
  private sources = new Set<string>();
  private remote = new Map<string, RemoteAudio>();
  private subscribing = new Set<string>();
  private sourceChanges?: Map<string, boolean>;
  private sending = Promise.resolve();
  private playback = Promise.resolve();
  private device?: ReturnType<WebVoice["load"]>;

  constructor(
    readonly channelId: string,
    readonly connectionId: string,
    private readonly audio: AudioContext,
    private readonly callAudio: MobileCallAudio,
    private readonly request: MediaRequest,
    private readonly changed: () => void,
    private volumes: Record<string, number>,
    private profile?: AudioPreferences,
  ) {
    this.output = audio.createGain();
    this.output.gain.value = (profile?.outputLevel ?? 100) / 100;
    this.output.connect(audio.destination);
  }

  get error() {
    return this.sendError ?? this.receiveError;
  }

  get whisperChannelId() {
    return this.publishing ? this.whisper?.targetId : undefined;
  }

  async configure(profile: AudioPreferences) {
    const previous = this.profile;
    this.profile = profile;
    this.output.gain.value = profile.outputLevel / 100;
    this.updateTransmission();
    if (previous && (["input", "echoCancellation", "noiseSuppression", "automaticGain"] as const)
      .some((key) => previous[key] !== profile[key])) {
      this.whisper = undefined;
      this.whisperTalking = false;
      await this.restartSending();
      if (this.sendError) throw new Error(this.sendError);
    } else {
      this.setCaptureProfile();
    }
  }

  setTalking(pressed: boolean) {
    this.talking = pressed;
    this.updateTransmission();
  }

  setWhisperTalking(pressed: boolean) {
    this.whisperTalking = pressed;
    this.updateTransmission();
  }

  async setWhisper(route?: WhisperRoute) {
    if (route && (!this.canSend || !this.publishing)) throw new Error("The microphone is unavailable.");
    if (!route && !this.whisper) return;
    this.whisper = route;
    this.talking = false;
    if (!route) this.whisperTalking = false;
    await this.restartSending();
    if (route && this.sendError && this.whisper === route) {
      const error = this.sendError;
      await this.setWhisper();
      throw new Error(error);
    }
    if (route && route !== this.whisper) throw new Error("The whisper ended before it connected.");
  }

  private updateTransmission() {
    clearInterval(this.talkLease);
    const capture = this.capture;
    if (!capture) return;
    const mode = this.profile?.transmitMode;
    const keyed = mode === "pushToTalk" || mode === "toggleToTalk";
    const pressed = this.whisper ? this.whisperTalking : !this.whisperTalking && this.talking;
    capture.track.enabled = this.whisper || keyed ? pressed : !this.whisperTalking;
    capture.processor.port.postMessage(pressed);
    // Keep the audio thread muted if the renderer stops processing the held shortcut.
    if (pressed && (keyed || this.whisper)) {
      this.talkLease = setInterval(() => capture.processor.port.postMessage(true), 200);
    }
  }

  private setCaptureProfile() {
    if (this.capture && this.profile) this.capture.processor.port.postMessage(this.profile);
  }

  get voice(): VoiceState["voice"] {
    if (this.error) return "error";
    if (!this.canReceive) return "deafened";
    if (!this.canSend) return "muted";
    return this.publishing || this.whisper ? "active" : "idle";
  }

  update(snapshot: Snapshot) {
    const member = snapshot.members.find(({ connectionId }) => connectionId === this.connectionId);
    if (!member) return;
    const { muted, deafened, adminMuted, adminDeafened, afk } = member;
    const receive = !deafened && !adminDeafened && !afk;
    const send = receive && !muted && !adminMuted;
    const bitrate = snapshot.channels.find(({ id }) => id === this.channelId)?.audioBitrate
      ?? snapshot.targetAudioBitrate ?? 48000;
    const bitrateChanged = bitrate !== this.bitrate;
    this.bitrate = bitrate;
    if (receive !== this.canReceive) {
      this.canReceive = receive;
      if (receive) this.playback = this.callAudio.setMode("playback", () => !this.closed && this.canReceive);
      this.restartReceiving();
    }
    if (send !== this.canSend) {
      this.canSend = send;
      if (!send) {
        this.whisper = undefined;
        this.talking = false;
        this.whisperTalking = false;
        this.releaseMicrophoneMode();
      }
      this.restartSending();
    } else if (send && bitrateChanged) {
      this.updateSendBitrate();
    }
  }

  setVolumes(volumes: Record<string, number>) {
    this.volumes = volumes;
    for (const { accountId, gain } of this.remote.values()) gain.gain.value = (volumes[accountId] ?? 100) / 100;
  }

  setVolume(accountId: string, level: number) {
    for (const entry of this.remote.values()) {
      if (entry.accountId === accountId) entry.gain.gain.value = level / 100;
    }
  }

  event(type: string, payload: VoiceEvent) {
    if (payload.channelId && payload.channelId !== this.channelId) return;
    if (type === "media.reset") {
      this.device = undefined;
      this.whisper = undefined;
      this.whisperTalking = false;
      this.restartReceiving();
      this.restartSending();
      return;
    }
    if (type === "media.whisperEnded" && this.whisper && payload.transportId === this.sender?.id) {
      void this.setWhisper();
      return;
    }
    if (type === "media.transportFailed" && payload.transportId) {
      if (payload.transportId === this.sender?.id) this.restartSending();
      if (payload.transportId === this.receiver?.id) this.restartReceiving();
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
    const { iceServers, ...routerRtpCapabilities } = await this.request<RtpCapabilities & { iceServers?: RTCIceServer[] }>("media.capabilities", { kind: "video" });
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities });
    return { device, iceServers };
  }

  private async open(direction: "send" | "receive", current: () => boolean, route?: WhisperRoute) {
    const loading = this.device ??= this.load();
    const { device, iceServers } = await loading.catch((error) => {
      if (this.device === loading) this.device = undefined;
      throw error;
    });
    if (!current()) return;
    const options = await this.request<TransportOptions>("media.transport.create", {
      direction, ...(route && { whisperChannelId: route.targetId, whisperPassword: route.password }),
    });
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
      if (direction === "send") {
        if (route) void this.setWhisper();
        else void this.failSending(message);
      } else this.failReceiving(message);
    });
    return { transport };
  }

  private closeServerTransport(transportId: string) {
    return this.request<void>("media.transport.close", { transportId }).catch(() => {});
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
      const route = this.whisper;
      const profile = this.profile;
      const processor = profile && await microphoneProcessor(this.audio, profile, Boolean(route));
      try {
        if (!current()) return;
        const stream = profile ? await openMicrophone(profile) : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const microphone = stream.getAudioTracks()[0];
        if (!microphone) throw new Error("No microphone is available.");
        if (!current()) {
          microphone.stop();
          return;
        }
        this.microphone = microphone;
        microphone.addEventListener("ended", () => {
          if (current()) void this.failSending("The microphone disconnected. Rejoin the channel to try again.");
        }, { once: true });
        if (processor) {
          const source = this.audio.createMediaStreamSource(stream);
          const destination = new MediaStreamAudioDestinationNode(this.audio, { channelCount: 1 });
          const track = destination.stream.getAudioTracks()[0];
          if (!track) throw new Error("Could not create the microphone track.");
          this.capture = { source, processor, track };
          this.setCaptureProfile();
          this.updateTransmission();
          source.connect(processor).connect(destination);
        }
      } finally {
        if (this.capture?.processor !== processor) processor?.port.close();
      }
      const opened = await this.open("send", current, route);
      if (!opened) return;
      const { transport } = opened;
      this.sender = transport;
      transport.on("produce", ({ kind, rtpParameters }, accept, reject) => {
        void this.request<{ id: string }>("media.producer.create", { transportId: transport.id, kind, rtpParameters })
          .then(accept, reject);
      });
      const producer = await transport.produce({
        track: this.capture?.track ?? this.microphone,
        encodings: [{ maxBitrate: this.bitrate }],
        codecOptions: { opusDtx: true, opusFec: true, opusStereo: false, opusMaxAverageBitrate: 128000, opusPtime: 20 },
      });
      if (!current()) return;
      this.producer = producer;
      this.publishing = true;
      this.changed();
    }).catch((error) => {
      if (current()) return this.failSending(error instanceof Error ? error.message : String(error));
    });
    return this.sending;
  }

  private updateSendBitrate() {
    const generation = this.sendGeneration;
    this.sending = this.sending.then(async () => {
      if (generation !== this.sendGeneration || !this.producer) return;
      const sender = this.producer.rtpSender;
      const parameters = sender?.getParameters();
      const encoding = parameters?.encodings[0];
      if (!sender || !parameters || !encoding) throw new Error("The voice bitrate could not be updated.");
      if (encoding.maxBitrate !== this.bitrate) {
        encoding.maxBitrate = this.bitrate;
        await sender.setParameters(parameters);
      }
      if (generation === this.sendGeneration && this.sendError) {
        this.sendError = null;
        this.changed();
      }
    }).catch((error) => {
      if (generation === this.sendGeneration) {
        this.sendError = error instanceof Error ? error.message : String(error);
        this.changed();
      }
    });
  }

  private stopSending() {
    clearInterval(this.talkLease);
    this.microphone?.stop();
    this.microphone = undefined;
    if (this.capture) {
      const { source, processor, track } = this.capture;
      track.stop();
      source.disconnect();
      processor.disconnect();
      processor.port.close();
      this.capture = undefined;
    }
    this.producer = undefined;
    this.publishing = false;
    const stopping = this.stopTransport(this.sender);
    this.sender = undefined;
    return stopping;
  }

  private failSending(message: string) {
    this.sendGeneration++;
    this.sendError = message;
    const stopping = this.stopSending();
    this.releaseMicrophoneMode();
    this.changed();
    return stopping;
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
      node.connect(gain).connect(this.output);
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
    this.output.disconnect();
  }
}
