import { Capacitor } from "@capacitor/core";

type DesktopEvent = "korero:state" | "korero:talk-shortcut";

interface DesktopBridge {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(event: DesktopEvent, callback: (payload: T) => void): () => void;
}

function desktop() {
  return typeof window === "undefined" ? undefined
    : (window as Window & { koreroDesktop?: DesktopBridge }).koreroDesktop;
}

export function desktopApp() {
  return Boolean(desktop());
}

export function mobileApp() {
  return Capacitor.isNativePlatform();
}

export function voiceApp() {
  return desktopApp() || (mobileApp() && typeof RTCPeerConnection === "function" && Boolean(navigator.mediaDevices?.getUserMedia));
}

export function call<T = void>(command: string, args: Record<string, unknown> = {}) {
  const bridge = desktop();
  if (bridge) return bridge.invoke<T>(command, args);
  return Promise.reject(new Error("This operation requires the Korero.chat desktop app."));
}

export async function watchDesktop<T>(event: DesktopEvent, callback: (payload: T) => void) {
  const bridge = desktop();
  if (!bridge) throw new Error("This operation requires the Korero.chat desktop app.");
  return bridge.listen(event, callback);
}
