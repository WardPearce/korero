import { Capacitor, registerPlugin } from "@capacitor/core";
import { speakerphone } from "./speakerphone.svelte";

type AudioMode = "auto" | "playback" | "play-and-record";

const androidCallAudio = registerPlugin<{
  start(options: { microphone: boolean }): Promise<void>;
  stop(): Promise<void>;
}>("CallAudio");

export class MobileCallAudio {
  private mode: AudioMode = "auto";
  private pending = Promise.resolve();

  setMode(mode: AudioMode, current = () => true) {
    const change = this.pending.then(async () => {
      if (!current() || mode === this.mode) return;
      const platform = Capacitor.getPlatform();
      if (platform === "android") {
        // Keep microphone eligibility through mute and channel switches in the background.
        if (this.mode === "play-and-record" && mode === "playback") return;
        if (mode === "auto") {
          await androidCallAudio.stop();
          speakerphone.reset();
        } else await androidCallAudio.start({ microphone: mode === "play-and-record" });
      } else if (platform === "ios") {
        const session = (navigator as Navigator & { audioSession?: { type: AudioMode } }).audioSession;
        if (session) session.type = mode;
      }
      this.mode = mode;
    });
    this.pending = change.catch(() => {});
    return change;
  }
}
