import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";

/**
 * Matches the Android system bar icon style to a theme. The bars themselves are
 * edge-to-edge, so their background is the app's own workspace colour; only the
 * icon/button contrast is set here, and it applies to both the status bar (top)
 * and navigation bar (bottom). No-op outside Android.
 */
export function applySystemBars(scheme: "light" | "dark") {
  if (Capacitor.getPlatform() !== "android") return;
  void SystemBars.setStyle({
    style: scheme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
  }).catch(() => {});
}
