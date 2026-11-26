import { browser } from "$app/environment";
import type { ThemeSelector } from "gridworkdesign";
import type { ComponentProps } from "svelte";
import logo from "../../static/vnx-logo.svg?raw";

type Theme = NonNullable<ComponentProps<typeof ThemeSelector>["value"]>;
const themes: readonly Theme[] = ["Gridwork", "NewsPaper", "BurntWood", "Hacker", "PurpleDaydream", "BloodRed"];
const storageKey = "vnx.chat:theme";

export function readTheme(): Theme {
  if (browser) {
    try {
      const saved = localStorage.getItem(storageKey);
      return themes.find((theme) => theme === saved) ?? "Gridwork";
    } catch {
      // Storage may be unavailable in a restricted webview.
    }
  }
  return "Gridwork";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
  if (favicon) {
    const primary = getComputedStyle(root).getPropertyValue("--foreground").trim();
    if (primary) favicon.href = `data:image/svg+xml,${encodeURIComponent(logo.replace(/fill="[^"]*"/, `fill="${primary}"`))}`;
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
