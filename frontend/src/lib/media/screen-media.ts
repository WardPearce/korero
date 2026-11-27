import type { ConsumerOptions, RtpCapabilities, Transport, TransportOptions } from "mediasoup-client/types";
import { browserSession } from "../connection/browser-session";
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

export async function chooseScreen(audio: boolean) {
  return navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: audio ? { echoCancellation: false, autoGainControl: false, noiseSuppression: false } : false,
  });
}

export class ScreenMedia {
  private transport?: Transport;
  private opening?: Promise<{ id: string }>;
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
      ? call<T>("screen_request", { connectionId, channelId, kind, payload })
      : browserSession.screenRequest<T>(connectionId, channelId, kind, payload);
  }

  private checkOpen() {
    if (this.closed) throw new Error(this.source === "camera" ? "Camera sharing ended." : "Screen sharing ended.");
  }

  private async connect(direction: "send" | "receive") {
    if (!supportsWebRtc()) throw new Error("This browser does not support WebRTC. Open VNX.chat in a browser with WebRTC support.");
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

  async share(stream: MediaStream, settings: ScreenSettings) {
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("Video capture ended.");
    track.contentHint = this.source === "screen" && settings.frameRate < 30 ? "detail" : "motion";
    await track.applyConstraints({
      ...(settings.resolution ? { height: { max: settings.resolution } } : {}),
      frameRate: { max: settings.frameRate },
    });
    this.checkOpen();
    const { device, transport } = await this.connect("send");
    if (!device.canProduce("video")) throw new Error("This browser cannot share VP8 video.");
    transport.on("produce", ({ kind, rtpParameters }, accept, reject) => {
      void this.request<{ id: string }>("media.producer.create", { transportId: transport.id, kind, rtpParameters })
        .then(accept, reject);
    });
    const audio = stream.getAudioTracks().find((track) => track.readyState === "live");
    if (audio && settings.audio) {
      const producer = await transport.produce({
        track: audio, stopTracks: false,
        codecOptions: { opusStereo: true, opusMaxAverageBitrate: settings.audioBitrate },
        encodings: [{ maxBitrate: settings.audioBitrate }],
      });
      producer.on("trackended", () => {
        producer.close();
        void this.request("media.producer.close", { producerId: producer.id }).catch(() => {});
      });
    }
    if (!settings.audio) audio?.stop();
    const producer = await transport.produce({
      track, stopTracks: false, encodings: [{ maxBitrate: settings.videoBitrate }],
    });
    this.checkOpen();
    return producer.id;
  }

  async watch(share: ScreenShare) {
    const { device, transport } = await this.connect("receive");
    const subscribe = async (producerId: string) => {
      const options = await this.request<ConsumerOptions>("media.consumer.create", {
        transportId: transport.id, producerId, rtpCapabilities: device.recvRtpCapabilities,
      });
      this.checkOpen();
      const consumer = await transport.consume(options);
      await this.request("media.consumer.resume", { consumerId: consumer.id });
      return consumer.track;
    };
    const stream = new MediaStream([await subscribe(share.producerId)]);
    if (share.audioProducerId) {
      try {
        stream.addTrack(await subscribe(share.audioProducerId));
      } catch {
        // The source can stop sending audio while a viewer is connecting.
      }
    }
    this.checkOpen();
    return stream;
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
