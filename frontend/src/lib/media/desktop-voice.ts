import { call } from "../connection/platform";
import type { VoiceState } from "../connection/client";
import { defaultAudio, type AudioPreferences } from "../preferences";
import { selectPlaybackDevice } from "./desktop-audio";
import { MobileCallAudio } from "./mobile-call-audio";
import { WebVoice, type VoiceEvent } from "./web-voice";

export interface DesktopMediaEvent {
  origin: string;
  connectionId: string;
  channelId: string;
  event: { type: string; payload: VoiceEvent };
}

export class DesktopVoice {
  private audio?: AudioContext;
  private callAudio = new MobileCallAudio();
  private profile = defaultAudio;
  private room?: { origin: string; voice: WebVoice };

  constructor(private readonly changed: (origin: string) => void) {}

  update(origin: string, state: VoiceState, volumes: Record<string, number>, roomChanged: boolean) {
    const snapshot = state.phase === "online" ? state.snapshot : null;
    if (!snapshot?.channelId) {
      this.leave(origin);
      return this.status(origin);
    }
    const { channelId, connectionId } = snapshot;
    if (this.room?.origin !== origin || this.room.voice.channelId !== channelId || this.room.voice.connectionId !== connectionId) {
      // State updates from a previous server can arrive after another call has taken over.
      if (!roomChanged) return this.status(origin);
      const previous = this.room?.origin;
      this.room?.voice.close();
      const audio = this.audio ??= new AudioContext();
      void audio.resume().catch(() => {});
      void selectPlaybackDevice(audio, this.profile.output).catch(() => {});
      const voice = new WebVoice(channelId, connectionId, audio, this.callAudio,
        (kind, payload) => call("media_request", { connectionId, channelId, kind, payload }),
        () => {
          if (this.room?.voice === voice) this.changed(origin);
        }, volumes, this.profile);
      this.room = { origin, voice };
      if (previous && previous !== origin) this.changed(previous);
    }
    this.room.voice.update(snapshot);
    return this.status(origin);
  }

  status(origin: string): Pick<VoiceState, "voice" | "voiceError" | "whisperChannelId"> {
    const voice = this.room?.origin === origin ? this.room.voice : undefined;
    return { voice: voice?.voice ?? "idle", voiceError: voice?.error ?? null, whisperChannelId: voice?.whisperChannelId };
  }

  event({ origin, connectionId, channelId, event }: DesktopMediaEvent) {
    const room = this.room;
    if (room?.origin === origin && room.voice.connectionId === connectionId && room.voice.channelId === channelId) {
      room.voice.event(event.type, event.payload);
    }
  }

  async configure(profile: AudioPreferences) {
    if (this.audio && this.profile.output !== profile.output) await selectPlaybackDevice(this.audio, profile.output);
    this.profile = profile;
    await this.room?.voice.configure(profile);
  }

  setVolumes(origin: string, volumes: Record<string, number>) {
    if (this.room?.origin === origin) this.room.voice.setVolumes(volumes);
  }

  setTalking(pressed: boolean) {
    this.room?.voice.setTalking(pressed);
  }

  setWhisperTalking(pressed: boolean) {
    this.room?.voice.setWhisperTalking(pressed);
  }

  async setWhisper(connectionId: string, channelId: string, targetId?: string, password?: string) {
    const voice = this.room?.voice;
    if (voice?.connectionId !== connectionId || voice.channelId !== channelId) throw new Error("The active channel changed.");
    await voice.setWhisper(targetId ? { targetId, password } : undefined);
  }

  leave(origin: string) {
    if (this.room?.origin !== origin) return;
    this.room.voice.close();
    this.room = undefined;
  }

  close() {
    if (this.room) this.leave(this.room.origin);
    void this.audio?.close().catch(() => {});
    this.audio = undefined;
  }
}
