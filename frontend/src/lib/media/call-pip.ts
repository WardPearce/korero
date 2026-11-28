import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type CallPipAction = "mute" | "deafen" | "leave";

export interface CallPipState {
  active: boolean;
  muted?: boolean;
  deafened?: boolean;
  canMute?: boolean;
  canDeafen?: boolean;
}

interface CallPipPlugin {
  update(state: CallPipState): Promise<void>;
  state(): Promise<{ supported: boolean; pictureInPicture: boolean }>;
  addListener(event: "change", listener: (event: { pictureInPicture: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: "action", listener: (event: { action: CallPipAction }) => void): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<CallPipPlugin>("CallPip");

/**
 * The WebView keeps the page scale it had in the tiny PiP window, so returning to full screen
 * leaves the app zoomed in. Pinning the scale to 1 prevents that; it removes nothing, because the
 * Android WebView has pinch zoom turned off (Capacitor's zoomEnabled is unset).
 */
function pinPageScale() {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport && !viewport.content.includes("maximum-scale")) {
    viewport.content += ", minimum-scale=1.0, maximum-scale=1.0, user-scalable=no";
  }
}

/** Android picture-in-picture for voice calls. Every call is a no-op on other platforms. */
export const callPip = {
  available: () => Capacitor.getPlatform() === "android",

  update(state: CallPipState) {
    if (!callPip.available()) return Promise.resolve();
    return plugin.update(state).catch(() => {});
  },

  /** Reports PiP changes and PiP action buttons. Returns a function that stops listening. */
  watch(onChange: (pictureInPicture: boolean) => void, onAction: (action: CallPipAction) => void) {
    if (!callPip.available()) return () => {};
    pinPageScale();
    const handles = [
      plugin.addListener("change", ({ pictureInPicture }) => onChange(pictureInPicture)),
      plugin.addListener("action", ({ action }) => onAction(action)),
    ];
    // A reloaded page may already be inside the PiP window.
    void plugin.state().then(({ pictureInPicture }) => onChange(pictureInPicture)).catch(() => {});
    return () => {
      for (const handle of handles) void handle.then((listener) => listener.remove()).catch(() => {});
    };
  },
};
