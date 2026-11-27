import type { AudioPreferences } from "../preferences";
import workletUrl from "./voice-processor.js?url&no-inline";

export async function openMicrophone(profile: AudioPreferences) {
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: profile.echoCancellation,
    noiseSuppression: profile.noiseSuppression,
    autoGainControl: profile.automaticGain,
  };
  if (profile.input) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: profile.input } } });
    } catch (error) {
      if (!(error instanceof DOMException) || !["OverconstrainedError", "NotFoundError"].includes(error.name)) throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: constraints });
}

const worklets = new WeakMap<AudioContext, Promise<void>>();

export async function microphoneProcessor(audio: AudioContext, profile: AudioPreferences, whisper: boolean) {
  let loaded = worklets.get(audio);
  if (!loaded) {
    loaded = audio.audioWorklet.addModule(workletUrl).catch((error) => {
      worklets.delete(audio);
      throw error;
    });
    worklets.set(audio, loaded);
  }
  await loaded;
  return new AudioWorkletNode(audio, "korero-voice", {
    channelCount: 1,
    channelCountMode: "explicit",
    outputChannelCount: [1],
    processorOptions: { profile, whisper },
  });
}

export async function selectPlaybackDevice(audio: AudioContext, deviceId: string) {
  const context = audio as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!context.setSinkId) return;
  try {
    await context.setSinkId(deviceId);
  } catch (error) {
    if (!deviceId || !(error instanceof DOMException) || !["NotFoundError", "NotAllowedError"].includes(error.name)) throw error;
    await context.setSinkId("");
  }
}
