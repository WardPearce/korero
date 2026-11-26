import { browser } from "$app/environment";
import logo from "../../static/vnx-logo.svg?raw";

export const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

type Theme = (typeof themeOptions)[number]["value"];
const storageKey = "vnx.chat:theme";
const legacyDarkThemes = new Set(["BurntWood", "Hacker", "PurpleDaydream", "BloodRed"]);

export function readTheme(): Theme {
  if (browser) {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "dark" || (saved && legacyDarkThemes.has(saved))) return "dark";
    } catch {
      // Storage may be unavailable in a restricted webview.
    }
  }
  return "light";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
  if (favicon) {
    const foreground = getComputedStyle(root).getPropertyValue("--foreground").trim();
    if (foreground) favicon.href = `data:image/svg+xml,${encodeURIComponent(logo.replace(/fill="[^"]*"/, `fill="${foreground}"`))}`;
  }
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The selector still applies the theme for the current session.
  }
}
