import { createContext } from "svelte";
import { call, messageFrom, nativeApp } from "./client";
import { defaultAudio, preferences, type AudioPreferences } from "./preferences";

interface AudioDevice { id: string; label: string }
interface AudioDevices { input: AudioDevice[]; output: AudioDevice[]; micTest: boolean }

export class AudioSettings {
  readonly available = nativeApp();
  profile = $state.raw<AudioPreferences>(defaultAudio);
  devices = $state.raw<AudioDevices | null>(null);
  error = $state("");
  deviceError = $state("");
  applying = $state(false);
  testing = $state(false);
  peak = $state<number | null>(null);
  #loading?: Promise<void>;
  #enumerating?: Promise<void>;
  #talkTimer?: ReturnType<typeof setInterval>;

  load() {
    return this.#loading ??= (async () => {
      try {
        const result = await preferences.local.get("audio");
        this.profile = { ...defaultAudio, ...(result?.value as Partial<AudioPreferences> | undefined) };
        if (this.available) await call("configure_audio", { profile: this.profile });
      } catch (error) {
        this.error = messageFrom(error);
      }
    })();
  }

  refreshDevices() {
    if (!this.available) return;
    this.#enumerating ??= call<AudioDevices>("get_audio_devices")
      .then((devices) => { this.devices = devices; this.deviceError = ""; })
      .catch((error) => { this.deviceError = messageFrom(error); })
      .finally(() => { this.#enumerating = undefined; });
    return this.#enumerating;
  }

  async update<K extends keyof AudioPreferences>(key: K, value: AudioPreferences[K]) {
    if (!this.available || this.applying || this.testing) return;
    this.applying = true;
    this.error = "";
    try {
      await this.load();
      const profile = { ...this.profile, [key]: value };
      await call("configure_audio", { profile });
      this.profile = profile;
      this.peak = null;
      await preferences.local.put({ key: "audio", value: profile });
    } catch (error) {
      this.error = messageFrom(error);
    } finally {
      this.applying = false;
    }
  }

  async test() {
    if (!this.devices?.micTest || this.testing || this.applying) return;
    this.testing = true;
    this.peak = null;
    this.error = "";
    try {
      await this.load();
      this.peak = await call<number>("microphone_test");
    } catch (error) {
      this.error = messageFrom(error);
    } finally {
      this.testing = false;
    }
  }

  talkKeyDown = (event: KeyboardEvent) => {
    if (this.profile.transmitMode !== "pushToTalk" || event.code !== "KeyV" || !event.altKey) return;
    event.preventDefault();
    if (this.#talkTimer !== undefined) return;
    const renew = () => void call("push_to_talk", { pressed: true }).catch(() => this.stopTalking());
    renew();
    this.#talkTimer = setInterval(renew, 200);
  };

  talkKeyUp = (event: KeyboardEvent) => {
    if (event.code === "KeyV" || event.key === "Alt") this.stopTalking();
  };

  stopTalking = () => {
    if (this.#talkTimer === undefined) return;
    clearInterval(this.#talkTimer);
    this.#talkTimer = undefined;
    void call("push_to_talk", { pressed: false }).catch(() => {});
  };
}

export const [getAudioSettings, setAudioSettings] = createContext<AudioSettings>();
