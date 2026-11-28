import { call } from "../connection/platform";
import processorUrl from "./application-audio-worklet.js?url&no-inline";

export interface ApplicationAudioSource {
  id: string;
  name: string;
}

export interface ApplicationAudioSetting extends ApplicationAudioSource {
  volume: number;
}

export interface ApplicationAudioMix {
  settings: ApplicationAudioSetting[];
  track: MediaStreamTrack;
  stop(): void;
}

export function listApplicationAudio() {
  return call<ApplicationAudioSource[]>("application_audio_list");
}

export async function mixApplicationAudio(settings: ApplicationAudioSetting[], disconnected: () => void): Promise<ApplicationAudioMix> {
  const context = new AudioContext({ sampleRate: 48000 });
  let sessionId: string | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let track: MediaStreamTrack | undefined;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    track?.stop();
    void context.close().catch(() => {});
    if (sessionId) void call("application_audio_stop", { id: sessionId }).catch(() => {});
  }

  try {
    await Promise.all([context.resume(), context.audioWorklet.addModule(processorUrl)]);
    const session = await call<{ id: string; applications: string[] }>("application_audio_start", {
      applications: settings.map(({ id }) => id),
    });
    sessionId = session.id;
    const destination = context.createMediaStreamDestination();
    track = destination.stream.getAudioTracks()[0];
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -3;
    compressor.knee.value = 3;
    compressor.connect(destination);

    const gains = new Map(settings.map(({ id, volume }) => {
      const gain = context.createGain();
      gain.gain.value = volume / 100;
      gain.connect(compressor);
      return [id, gain];
    }));
    const players = session.applications.map((id) => {
      const player = new AudioWorkletNode(context, "korero-application-audio", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      player.connect(gains.get(id)!);
      return player;
    });
    async function read() {
      try {
        const chunks = await call<(ArrayBuffer | null)[] | undefined>("application_audio_read", { id: session.id });
        if (stopped) return;
        if (!chunks || chunks.every((chunk) => chunk === null)) throw new Error("Application audio capture ended.");
        for (const [i, chunk] of chunks.entries()) {
          if (chunk?.byteLength) players[i].port.postMessage(chunk, [chunk]);
        }
        timer = setTimeout(() => { void read(); }, 20);
      } catch {
        if (stopped) return;
        stop();
        disconnected();
      }
    }

    void read();
    return { settings, track, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
