import { createContext } from "svelte";
import { watchDesktop } from "../connection/platform";
import { call, messageFrom, desktopApp } from "../connection/client";
import type { DesktopVoice } from "./desktop-voice";
import { defaultAudio, preferences, type AudioPreferences } from "../preferences";
import { globalTalkShortcut, isTypingTalkShortcut, matchesTalkShortcut, releasesTalkShortcut } from "./talk-shortcut";

interface AudioDevice { id: string; label: string }
interface AudioDevices { input: AudioDevice[]; output: AudioDevice[] }

export class AudioSettings {
  readonly available = desktopApp();
  profile = $state.raw<AudioPreferences>(defaultAudio);
  devices = $state.raw<AudioDevices | null>(null);
  error = $state("");
  deviceError = $state("");
  applying = $state(false);
  talking = $state(false);
  globalActive = $state(false);
  shortcutError = $state("");
  #loading?: Promise<void>;
  #enumerating?: Promise<void>;
  #talkContext?: { connectionId: string; channelId: string };
  #pressed = false;
  #globalKey: string | null = null;
  #unlisten?: () => void;

  constructor(readonly voice: DesktopVoice) {}

  private async registerShortcut() {
    const { profile } = this;
    this.#globalKey = null;
    this.globalActive = false;
    this.shortcutError = "";
    const requested = profile.globalTalkShortcut && ["pushToTalk", "toggleToTalk"].includes(profile.transmitMode);
    const shortcut = requested ? globalTalkShortcut(profile.talkShortcut) : null;
    try {
      if (requested && !this.#unlisten) {
        this.#unlisten = await watchDesktop<{ shortcut: string; pressed: boolean }>("korero:talk-shortcut", (payload) => {
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
          await this.voice.configure(this.profile);
          await this.registerShortcut();
        }
      } catch (error) {
        this.error = messageFrom(error);
      }
    })();
  }

  refreshDevices() {
    if (!this.available) return;
    this.#enumerating ??= navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        const list = (kind: MediaDeviceKind, label: string) => devices
          .filter(({ kind: type, deviceId }) => type === kind && deviceId && !["default", "communications"].includes(deviceId))
          .map(({ deviceId, label: name }, index) => ({ id: deviceId, label: name || `${label} ${index + 1}` }));
        this.devices = { input: list("audioinput", "Microphone"), output: list("audiooutput", "Playback device") };
        this.deviceError = "";
      })
      .catch((error) => { this.deviceError = messageFrom(error); })
      .finally(() => { this.#enumerating = undefined; });
    return this.#enumerating;
  }

  async update<K extends keyof AudioPreferences>(key: K, value: AudioPreferences[K]) {
    if (!this.available || this.applying) return;
    this.applying = true;
    this.error = "";
    try {
      await this.load();
      const profile = { ...this.profile, [key]: value };
      this.resetTalk();
      try {
        await this.voice.configure(profile);
      } catch (error) {
        await this.voice.configure(this.profile).catch(() => {});
        throw error;
      }
      this.profile = profile;
      if (key === "transmitMode" || key === "talkShortcut" || key === "globalTalkShortcut") await this.registerShortcut();
      await preferences.local.put({ key: "audio", value: profile });
    } catch (error) {
      this.error = messageFrom(error);
    } finally {
      this.applying = false;
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
    this.voice.setTalking(true);
  }

  private release() {
    this.#pressed = false;
    if (this.profile.transmitMode === "pushToTalk") this.stopTalking();
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
    this.voice.setTalking(false);
  }

  resetTalk() {
    this.#pressed = false;
    this.stopTalking();
  }

  dispose() {
    this.setTalkContext();
    this.voice.close();
    this.#unlisten?.();
    if (this.#globalKey) void call("configure_talk_shortcut", { shortcut: null }).catch(() => {});
  }
}

export const [getAudioSettings, setAudioSettings] = createContext<AudioSettings>();
