import type { Consumer, ConsumerOptions, Device, Producer, RtpCapabilities, Transport, TransportOptions } from "mediasoup-client/types";
import { browserSessions } from "../connection/browser-session";
import { call, desktopApp, type ScreenShare } from "../connection/client";

type ScreenCapabilities = RtpCapabilities & { iceServers: RTCIceServer[] };
export type VideoSource = "screen" | "camera";
export type MediaRequest = <T>(kind: string, payload: Record<string, unknown>) => Promise<T>;
export const supportsWebRtc = () => typeof globalThis.RTCPeerConnection === "function";
export interface ScreenSettings {
  resolution: number | null;
  frameRate: number;
  videoBitrate: number;
  audio: boolean;
  audioBitrate: number;
}

export interface ScreenSubscription {
  stream: Promise<MediaStream>;
  setAudioProducer: (producerId?: string) => void;
  close: () => Promise<void>;
}

export async function chooseScreen(audio: boolean) {
  return navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: audio ? { echoCancellation: false, autoGainControl: false, noiseSuppression: false } : false,
  });
}

export class ScreenMedia {
  private transport?: Transport;
  private opening?: Promise<{ id: string }>;
  private receiving?: Promise<{ device: Device; transport: Transport }>;
  private videoProducer?: Producer;
  private audioProducer?: Producer;
  private closed = false;

  constructor(
    private readonly connectionId: string,
    private readonly channelId: string,
    private readonly failed: (message: string) => void,
    private readonly source: VideoSource = "screen",
  ) {}

  private request<T>(kind: string, payload: Record<string, unknown>) {
    const { connectionId, channelId } = this;
    return desktopApp()
      ? call<T>("media_request", { connectionId, channelId, kind, payload })
      : browserSessions.screenRequest<T>(connectionId, channelId, kind, payload);
  }

  private checkOpen() {
    if (this.closed) throw new Error(this.source === "camera" ? "Camera sharing ended." : "Screen sharing ended.");
  }

  private async connect(direction: "send" | "receive") {
    if (!supportsWebRtc()) throw new Error("This browser does not support WebRTC. Open Korero.chat in a browser with WebRTC support.");
    const { Device } = await import("mediasoup-client");
    this.checkOpen();
    const { iceServers, ...routerRtpCapabilities } = await this.request<ScreenCapabilities>("media.capabilities", { kind: "video" });
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities });
    this.checkOpen();

    const opening = this.request<TransportOptions>("media.transport.create", {
      direction, kind: "video", ...(this.source === "camera" ? { videoSource: "camera" } : {}),
    });
    this.opening = opening;
    const options = await opening;
    try {
      this.checkOpen();
      const transport = direction === "send"
        ? device.createSendTransport({ ...options, iceServers })
        : device.createRecvTransport({ ...options, iceServers });
      this.transport = transport;
      transport.on("connect", ({ dtlsParameters }, accept, reject) => {
        void this.request("media.transport.connect", { transportId: transport.id, dtlsParameters })
          .then(() => accept(), (error) => reject(error));
      });
      transport.on("connectionstatechange", (state) => {
        if (!this.closed && state === "failed") this.failed(`The ${this.source} sharing connection failed.`);
      });
      return { device, transport };
    } catch (error) {
      if (!this.closed) await this.closeTransport(options.id);
      throw error;
    }
  }

  private async configureVideo(stream: MediaStream, settings: ScreenSettings) {
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("Video capture ended.");
    track.contentHint = this.source === "screen" && settings.frameRate < 30 ? "detail" : "motion";
    await track.applyConstraints({
      ...(settings.resolution ? { height: { max: settings.resolution } } : {}),
      frameRate: { max: settings.frameRate },
    });
    this.checkOpen();
    if (track.readyState !== "live") throw new Error("Video capture ended.");
    return track;
  }

  async share(stream: MediaStream, settings: ScreenSettings) {
    const track = await this.configureVideo(stream, settings);
    const { device, transport } = await this.connect("send");
    if (!device.canProduce("video")) throw new Error("This browser cannot share VP8 video.");
    transport.on("produce", ({ kind, rtpParameters }, accept, reject) => {
      void this.request<{ id: string }>("media.producer.create", { transportId: transport.id, kind, rtpParameters })
        .then(accept, reject);
    });
    await this.updateAudio(transport, stream, settings);
    const producer = await transport.produce({
      track, stopTracks: false, encodings: [{ maxBitrate: settings.videoBitrate }],
    });
    this.checkOpen();
    this.videoProducer = producer;
    return producer.id;
  }

  async updateShare(stream: MediaStream, settings: ScreenSettings) {
    const video = this.videoProducer;
    const transport = this.transport;
    if (!video || !transport) throw new Error("Screen sharing is still connecting.");
    const track = await this.configureVideo(stream, settings);
    await video.setRtpEncodingParameters({ maxBitrate: settings.videoBitrate });
    if (video.track !== track) await video.replaceTrack({ track });
    await this.updateAudio(transport, stream, settings);
    this.checkOpen();
  }

  private async updateAudio(transport: Transport, stream: MediaStream, settings: ScreenSettings) {
    const track = settings.audio ? stream.getAudioTracks().find((entry) => entry.readyState === "live") : undefined;
    const current = this.audioProducer;
    if (!track) {
      if (current) await this.closeAudio(current);
    } else if (current) {
      await current.setRtpEncodingParameters({ maxBitrate: settings.audioBitrate });
      if (current.track !== track) await current.replaceTrack({ track });
    } else {
      const producer = await transport.produce({
        track, stopTracks: false,
        codecOptions: { opusStereo: true, opusMaxAverageBitrate: 320000 },
        encodings: [{ maxBitrate: settings.audioBitrate }],
      });
      this.audioProducer = producer;
      producer.on("trackended", () => { void this.closeAudio(producer); });
    }
  }

  private async closeAudio(producer: Producer) {
    if (this.audioProducer !== producer) return;
    this.audioProducer = undefined;
    producer.close();
    await this.request("media.producer.close", { producerId: producer.id }).catch(() => {});
  }

  watch(share: ScreenShare): ScreenSubscription {
    const cancellation = new AbortController();
    const consumers = new Map<string, Consumer | undefined>();
    const checkOpen = () => {
      cancellation.signal.throwIfAborted();
      this.checkOpen();
    };

    const closeConsumer = async (id: string) => {
      consumers.get(id)?.close();
      consumers.delete(id);
      if (!this.closed) await this.request("media.consumer.close", { consumerId: id }).catch(() => {});
    };

    this.receiving ??= this.connect("receive").catch((error: unknown) => {
      this.receiving = undefined;
      throw error;
    });
    const receiving = this.receiving;
    const subscribe = async (producerId: string) => {
      const { device, transport } = await receiving;
      checkOpen();
      const options = await this.request<ConsumerOptions>("media.consumer.create", {
        transportId: transport.id, producerId, rtpCapabilities: device.recvRtpCapabilities,
      });
      consumers.set(options.id, undefined);
      try {
        checkOpen();
        const consumer = await transport.consume(options);
        consumers.set(consumer.id, consumer);
        checkOpen();
        await this.request("media.consumer.resume", { consumerId: consumer.id });
        checkOpen();
        return consumer;
      } catch (error) {
        await closeConsumer(options.id);
        throw error;
      }
    };
    const stream = subscribe(share.producerId).then(({ track }) => new MediaStream([track]));
    let currentAudio: Consumer | undefined;
    let desiredAudio: string | undefined;
    let audioUpdates = Promise.resolve();
    const setAudioProducer = (producerId?: string) => {
      if (producerId === desiredAudio || cancellation.signal.aborted) return;
      desiredAudio = producerId;
      audioUpdates = audioUpdates.then(async () => {
        const result = await stream;
        checkOpen();
        if (producerId !== desiredAudio || producerId === currentAudio?.producerId) return;
        if (currentAudio) {
          result.removeTrack(currentAudio.track);
          await closeConsumer(currentAudio.id);
          currentAudio = undefined;
        }
        if (!producerId || producerId !== desiredAudio) return;
        const audio = await subscribe(producerId);
        if (producerId === desiredAudio && !cancellation.signal.aborted) {
          currentAudio = audio;
          result.addTrack(audio.track);
        } else await closeConsumer(audio.id);
      }).catch(() => {});
    };
    setAudioProducer(share.audioProducerId);
    return {
      stream,
      setAudioProducer,
      close: async () => {
        cancellation.abort();
        for (const consumer of consumers.values()) consumer?.close();
        await stream.catch(() => {});
        await audioUpdates;
        await Promise.all([...consumers.keys()].map(closeConsumer));
      },
    };
  }

  private async closeTransport(transportId: string) {
    await this.request("media.transport.close", { transportId }).catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.transport?.close();
    const options = await this.opening?.catch(() => undefined);
    if (options) await this.closeTransport(options.id);
  }
}
