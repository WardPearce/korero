import { createContext } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { call, messageFrom, nativeApp } from "../connection/client";
import { defaultAudio, preferences, type AudioPreferences } from "../preferences";
import { globalTalkShortcut, isTypingTalkShortcut, matchesTalkShortcut, releasesTalkShortcut } from "./talk-shortcut";

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
  talking = $state(false);
  globalActive = $state(false);
  shortcutError = $state("");
  #loading?: Promise<void>;
  #enumerating?: Promise<void>;
  #talkTimer?: ReturnType<typeof setInterval>;
  #talkCommand = Promise.resolve();
  #talkGeneration = 0;
  #talkContext?: { connectionId: string; channelId: string };
  #renewing = false;
  #pressed = false;
  #globalKey: string | null = null;
  #unlisten?: () => void;

  private configureMicrophone(profile: AudioPreferences) {
    const { talkShortcut: _shortcut, globalTalkShortcut: _global, ...nativeProfile } = profile;
    const transmitMode = profile.transmitMode === "toggleToTalk" ? "pushToTalk" : profile.transmitMode;
    return call("configure_audio", { profile: { ...nativeProfile, transmitMode } });
  }

  private async registerShortcut() {
    const { profile } = this;
    this.#globalKey = null;
    this.globalActive = false;
    this.shortcutError = "";
    const requested = profile.globalTalkShortcut && ["pushToTalk", "toggleToTalk"].includes(profile.transmitMode);
    const shortcut = requested ? globalTalkShortcut(profile.talkShortcut) : null;
    try {
      if (requested && !this.#unlisten) {
        this.#unlisten = await listen<{ shortcut: string; pressed: boolean }>("korero:talk-shortcut", ({ payload }) => {
          if (payload.shortcut !== this.#globalKey) return;
          if (payload.pressed) this.press();
          else this.release();
        });
      }
      await call("configure_talk_shortcut", { shortcut });
      this.#globalKey = shortcut;
      this.globalActive = Boolean(shortcut);
      if (requested && !shortcut) this.shortcutError = "Choose a function key or a shortcut with Ctrl, Alt or Super for system-wide use.";
    } catch (error) {
      if (requested) this.shortcutError = messageFrom(error);
    }
  }

  load() {
    return this.#loading ??= (async () => {
      try {
        const result = await preferences.local.get("audio");
        this.profile = { ...defaultAudio, ...(result?.value as Partial<AudioPreferences> | undefined) };
        if (this.available) {
          await this.configureMicrophone(this.profile);
          await this.registerShortcut();
        }
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
      this.resetTalk();
      await this.configureMicrophone(profile);
      this.profile = profile;
      if (key === "transmitMode" || key === "talkShortcut" || key === "globalTalkShortcut") await this.registerShortcut();
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

  setTalkContext(context?: { connectionId: string; channelId: string }) {
    if (!context || context.connectionId !== this.#talkContext?.connectionId || context.channelId !== this.#talkContext?.channelId) {
      this.resetTalk();
    }
    this.#talkContext = context;
  }

  private press() {
    if (this.#pressed || !this.#talkContext || this.applying) return;
    const { transmitMode } = this.profile;
    if (transmitMode !== "pushToTalk" && transmitMode !== "toggleToTalk") return;
    this.#pressed = true;
    if (this.talking && transmitMode === "toggleToTalk") return this.stopTalking();
    this.talking = true;
    const generation = ++this.#talkGeneration;
    const renew = () => {
      if (this.#renewing) return;
      this.#renewing = true;
      void this.sendTalkState(true, generation).finally(() => { this.#renewing = false; });
    };
    renew();
    this.#talkTimer = setInterval(renew, 200);
  }

  private release() {
    this.#pressed = false;
    if (this.profile.transmitMode === "pushToTalk") this.stopTalking();
  }

  private sendTalkState(pressed: boolean, generation: number) {
    this.#talkCommand = this.#talkCommand.then(async () => {
      if (pressed && generation !== this.#talkGeneration) return;
      await call("push_to_talk", { pressed, ...this.#talkContext });
    }).catch(() => {
      if (pressed && generation === this.#talkGeneration) this.stopTalking();
    });
    return this.#talkCommand;
  }

  talkKeyDown = (event: KeyboardEvent) => {
    const { talkShortcut, transmitMode } = this.profile;
    if (event.defaultPrevented || event.repeat || this.globalActive || !this.#talkContext ||
        (transmitMode !== "pushToTalk" && transmitMode !== "toggleToTalk") ||
        !matchesTalkShortcut(event, talkShortcut) || isTypingTalkShortcut(event, talkShortcut)) return;
    event.preventDefault();
    this.press();
  };

  talkKeyUp = (event: KeyboardEvent) => {
    if (!this.globalActive && releasesTalkShortcut(event, this.profile.talkShortcut)) this.release();
  };

  talkWindowBlur = () => {
    if (!this.globalActive) this.release();
  };

  private stopTalking() {
    if (!this.talking) return;
    this.talking = false;
    clearInterval(this.#talkTimer);
    this.#talkTimer = undefined;
    this.sendTalkState(false, ++this.#talkGeneration);
  }

  resetTalk() {
    this.#pressed = false;
    this.stopTalking();
  }

  dispose() {
    this.setTalkContext();
    this.#unlisten?.();
    if (this.#globalKey) void call("configure_talk_shortcut", { shortcut: null }).catch(() => {});
  }
}

export const [getAudioSettings, setAudioSettings] = createContext<AudioSettings>();
