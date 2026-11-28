import { Capacitor, registerPlugin } from "@capacitor/core";

const androidCallAudio = registerPlugin<{ setSpeaker(options: { on: boolean }): Promise<void> }>("CallAudio");

let on = $state(false);
let pending = Promise.resolve();

function route(next: boolean) {
  const change = pending.then(() => androidCallAudio.setSpeaker({ on: next }));
  pending = change.catch(() => {});
  return change;
}

/** Android loudspeaker routing for voice calls. Other platforms pick their own output. */
export const speakerphone = {
  available: () => Capacitor.getPlatform() === "android",
  get on() {
    return on;
  },

  async toggle() {
    const next = !on;
    on = next;
    try {
      await route(next);
    } catch {
      on = !next;
    }
  },

  /** The WebView resets the route when it opens the microphone, so put the user's choice back. */
  reapply() {
    if (on) void route(true).catch(() => {});
  },

  /** Calls end on the default route; the native side has already cleared it. */
  reset() {
    on = false;
  },
};
