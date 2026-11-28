import { Capacitor } from "@capacitor/core";

type DesktopEvent = "korero:state" | "korero:media" | "korero:talk-shortcut" | "korero:capture-sources" | "korero:capture-previews";

interface DesktopBridge {
  applicationAudio?: boolean;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(event: DesktopEvent, callback: (payload: T) => void): () => void;
  chooseCapture(id: string, sourceId: string | null): Promise<void>;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string | null;
  icon: string | null;
}

export interface CaptureRequest {
  id: string;
  /** Whether thumbnails and icons will follow in a `korero:capture-previews` event. */
  previews: boolean;
  sources: CaptureSource[];
}

export interface CapturePreviews {
  id: string;
  sources: CaptureSource[];
}

function desktop() {
  return typeof window === "undefined" ? undefined
    : (window as Window & { koreroDesktop?: DesktopBridge }).koreroDesktop;
}

export function desktopApp() {
  return Boolean(desktop());
}

export function supportsApplicationAudio() {
  return desktop()?.applicationAudio === true && typeof AudioWorkletNode === "function";
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

export function chooseCapture(id: string, sourceId: string | null) {
  const bridge = desktop();
  if (bridge) return bridge.chooseCapture(id, sourceId);
  return Promise.reject(new Error("This operation requires the Korero.chat desktop app."));
}
