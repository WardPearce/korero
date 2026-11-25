import { Device } from "mediasoup-client";
import type { Consumer, Transport } from "mediasoup-client/types";
import type { Snapshot, Device as Account } from "../server";

async function api<T>(path: string, payload: unknown, accessToken?: string): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method: "POST", headers: { "content-type": "application/json", ...(accessToken ? { authorization: "Bearer " + accessToken } : {}) },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code ?? "HTTP failure");
  return data;
}

const observed: { type: string; payload: Record<string, unknown> }[] = [];
let device: Device;
let auth: Account;
let socket: WebSocket;
let rpcId = 0;
let audio: AudioContext;
let oscillator: OscillatorNode;
let consumer: Consumer;
let analyser: AnalyserNode;
let sink: GainNode;
let element: HTMLAudioElement;
let sender: Transport;
let receiver: Transport | undefined;
let lobby: string;
let lastClose = 0;
const pending = new Map<number, { resolve: (payload: unknown) => void; reject: (reason: Error) => void }>();

async function rpc<T>(type: string, payload: unknown = {}): Promise<T> {
  const id = ++rpcId;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (payload) => resolve(payload as T), reject });
      timeout = setTimeout(() => reject(new Error("WebSocket response timeout for " + type)), 4000);
      socket.send(JSON.stringify({ version: 1, id, type, payload }));
    });
  } finally { clearTimeout(timeout); pending.delete(id); }
}

export async function initialize(name: string) {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = (await crypto.subtle.exportKey("jwk", key.publicKey)).x!;
  const deviceName = "Test browser";
  const operation = "register";
  const origin = location.origin;
  const { id, serverId, binding, expiresAt } = await api<{ id: string; serverId: string; binding: string; expiresAt: number }>(
    "auth/identity/challenge", { operation, publicKey, deviceName, origin },
  );
  const transcript = new TextEncoder().encode(JSON.stringify(
    ["korero-identity-v1", serverId, origin, operation, id, publicKey, binding, deviceName, expiresAt],
  ));
  const signed = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, transcript));
  const signature = btoa(String.fromCharCode(...signed)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  auth = await api<Account>("auth/register", { displayName: name, deviceName, identity: { id, signature } });
  const { ticket } = await api<{ ticket: string }>("auth/connection-ticket", {}, auth.accessToken);
  socket = new WebSocket("wss://" + location.host + "/api/v1/ws");
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Authenticated test socket could not open"));
  });
  socket.onclose = ({ code }) => {
    lastClose = code;
    for (const entry of pending.values()) entry.reject(new Error("WebSocket closed"));
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "response") {
      const slot = pending.get(message.id);
      if (message.success) slot?.resolve(message.payload);
      else slot?.reject(new Error(message.error.code));
    } else observed.push(message);
  };
  const state = await rpc<Snapshot>("connection.authenticate", { ticket, versions: [1] });
  lobby = state.channels.find((entry) => entry.name === "Lobby")!.id;
  await join();
  return { connectionId: state.connectionId, sessionId: auth.sessionId, accountId: auth.account.id };
}
async function join(channelId = lobby) {
  sender?.close();
  receiver?.close();
  receiver = undefined;
  if (oscillator) { oscillator.disconnect(); }
  await rpc("channel.join", { channelId });
  device = await Device.factory();
  await device.load({ routerRtpCapabilities: await rpc("media.capabilities") });
}

async function transport(direction: "send" | "receive", forceTcp: boolean) {
  const options = await rpc<Parameters<Device["createSendTransport"]>[0]>("media.transport.create", { direction, forceTcp });
  const rtc = direction === "send" ? device.createSendTransport(options) : device.createRecvTransport(options);
  rtc.on("connect", ({ dtlsParameters }, ok, fail) => {
    rpc("media.transport.connect", { transportId: rtc.id, dtlsParameters }).then(ok, fail);
  });
  return rtc;
}
async function publish(forceTcp: boolean) {
  sender = await transport("send", forceTcp);
  sender.on("produce", ({ kind, rtpParameters }, ok, fail) => {
    rpc<{ id: string }>("media.producer.create", { transportId: sender.id, kind, rtpParameters }).then(ok, fail);
  });
  audio ??= new AudioContext();
  oscillator = audio.createOscillator();
  oscillator.frequency.value = 523.25;
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  await audio.resume();
  return (await sender.produce({ track: destination.stream.getAudioTracks()[0]!,
    codecOptions: { opusDtx: true, opusFec: true, opusStereo: false, opusMaxAverageBitrate: 48000, opusPtime: 20 } })).id;
}
async function subscribe(producerId: string, forceTcp: boolean) {
  if (receiver) {
    await rpc("media.transport.close", { transportId: receiver.id });
    receiver.close();
  }
  receiver = await transport("receive", forceTcp);
  return rpc<Parameters<Transport["consume"]>[0]>("media.consumer.create", {
    transportId: receiver.id, producerId, rtpCapabilities: device.recvRtpCapabilities,
  });
}
async function consume(producerId: string, forceTcp: boolean) {
  const parameters = await subscribe(producerId, forceTcp);
  consumer = await receiver!.consume(parameters);
  const stream = new MediaStream([consumer.track]);
  audio ??= new AudioContext();
  element = new Audio();
  element.srcObject = stream;
  element.muted = true;
  await element.play();
  analyser = audio.createAnalyser();
  sink = audio.createGain();
  sink.gain.value = 0;
  audio.createMediaStreamSource(stream).connect(analyser).connect(sink).connect(audio.destination);
  await audio.resume();
  await rpc("media.consumer.resume", { consumerId: consumer.id });
  const samples = new Float32Array(analyser.fftSize);
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    analyser.getFloatTimeDomainData(samples);
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    if (peak > 0.03) {
      const rows = [...(await consumer.getStats()).values()];
      const inbound = rows.find((row) => row.type === "inbound-rtp");
      const codec = rows.find((row) => row.id === inbound?.codecId);
      const tuple = await rpc<{ iceSelectedTuple?: { protocol: string } }[]>("media.transport.stats", { transportId: receiver!.id });
      return { consumerId: consumer.id, peak, codec: codec?.mimeType as string, packets: inbound?.packetsReceived as number, protocol: tuple[0]?.iceSelectedTuple?.protocol };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("No decoded synthetic audio was received");
}
function stats() { return consumer.getStats().then((report) =>
  ([...report.values()].find((row) => row.type === "inbound-rtp")?.packetsReceived ?? 0) as number); }

async function counters() {
  const rows = await rpc<{ bytesSent: number; bytesReceived: number }[]>("media.transport.stats", { transportId: (receiver ?? sender).id });
  return { bytesSent: rows[0]!.bytesSent, bytesReceived: rows[0]!.bytesReceived };
}
export const harness = { counters, initialize, join, publish, consume, subscribe, rpc, stats, events: () => observed, closeCode: () => lastClose };
Object.assign(window, { harness });
