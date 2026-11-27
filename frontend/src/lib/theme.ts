import { browser } from "$app/environment";
import logo from "../../static/korero-logo.svg?raw";

export const colorFields = [
  ["background", "Workspace"], ["panel", "Sidebars"], ["surface", "Cards and menus"],
  ["text", "Text"], ["mutedText", "Secondary text"], ["border", "Borders"], ["input", "Field borders"],
  ["primary", "Primary"], ["secondary", "Secondary"], ["accent", "Selection"], ["success", "Success"],
  ["danger", "Danger"], ["warning", "Warning"], ["info", "Info"],
] as const;

type Color = (typeof colorFields)[number][0];
type Colors = Record<Color, string>;
type Density = "compact" | "comfortable" | "spacious";
export type Theme = {
  name: string;
  scheme: "light" | "dark";
  colors: Colors;
  radius: number;
  density: Density;
  textSize: number;
};
export type SavedTheme = Theme & { id: string };
export type Appearance = { active: string; custom: SavedTheme[]; glassmorphism: boolean };

export const swatchColors = ["primary", "secondary", "accent", "success", "danger", "warning", "info"] as const;

type Swatches = [string, string, string, string, string, string, string];
type Surfaces = [
  background: string, panel: string, surface: string, border: string, input: string,
  text?: string, mutedText?: string,
];
const darkSwatches: Swatches = ["#a2bbff", "#9a95b7", "#bba7ef", "#6fd5a0", "#ff929b", "#f6bf74", "#83d3ee"];
const lightSwatches: Swatches = ["#365ec0", "#625a77", "#7541af", "#217443", "#b73251", "#87540a", "#1c6585"];

function preset(id: string, name: string, scheme: Theme["scheme"], surfaces: Surfaces, swatches: Swatches, radius = 10): SavedTheme {
  const [defaultText, defaultMutedText] = scheme === "dark"
    ? ["#f1f3fa", "#adb7cb"] as const : ["#222638", "#505a6c"] as const;
  const [background, panel, surface, border, input, text = defaultText, mutedText = defaultMutedText] = surfaces;
  const [primary, secondary, accent, success, danger, warning, info] = swatches;
  return { id, name, scheme, radius, density: "comfortable", textSize: 100, colors: {
    background, panel, surface, border, input, text, mutedText, primary, secondary, accent, success, danger, warning, info,
  } };
}

export const defaultTheme = preset("korero", "Kōrero", "dark",
  ["#101820", "#16212b", "#1e2c38", "#344758", "#627c90", "#f2f6fa", "#aabac8"],
  ["#5ce0cc", "#8ea5bc", "#b7acf3", "#6fd5a0", "#ff929b", "#f6bf74", "#83d3ee"]);

export const playfulThemes = [
  preset("arcade", "Arcade", "dark", ["#100d21", "#1a1232", "#241745", "#44316a", "#8062a8", "#fff2ff", "#cdbbe3"],
    ["#ff76d8", "#6eecff", "#bc95ff", "#83f7a6", "#ff8a9f", "#ffe175", "#79ccff"], 4),
  preset("bubblegum", "Bubblegum", "light", ["#fff0f7", "#f8deed", "#fff9fc", "#e3b6cd", "#a3688c", "#43253e", "#724561"],
    ["#a21564", "#7043a3", "#b52b67", "#25754f", "#ae2743", "#92550a", "#275e9e"], 20),
  preset("terminal", "Terminal", "dark", ["#0a100b", "#101a12", "#152319", "#31533a", "#56835e", "#d2f6d5", "#93bc98"],
    ["#88ff9a", "#55cabe", "#b6e779", "#82ffa2", "#ffa58a", "#f2ce72", "#93dcff"], 0),
  preset("peach-soda", "Peach Soda", "light", ["#fff2e9", "#f9e0d3", "#fff9f4", "#ebc6b6", "#a47261", "#482c2b", "#785044"],
    ["#ad4231", "#89496e", "#ab4a19", "#327443", "#b83148", "#865514", "#286989"], 18),
  preset("vaporwave", "Vaporwave", "dark", ["#211133", "#2c1944", "#362256", "#5a4180", "#997ab8", "#fff1fb", "#d5badf"],
    ["#ff9fdf", "#8bece8", "#b8a5ff", "#9de5b6", "#ff9ac4", "#ffc889", "#87d6ff"], 14),
  preset("matcha-mochi", "Matcha Mochi", "light", ["#f5f7e7", "#e8edce", "#fcfcf1", "#cdd6a8", "#778453", "#303a20", "#535f3b"],
    ["#456126", "#74543b", "#5e6d24", "#297342", "#ab3e49", "#85590c", "#266d77"], 16),
  preset("cherry-cola", "Cherry Cola", "dark", ["#210f17", "#2c1720", "#371d29", "#583444", "#a56883", "#fff0f2", "#d6abb7"],
    ["#ff9dad", "#db91be", "#faac8d", "#91daa9", "#ff8899", "#f8c783", "#96c7ee"], 10),
  preset("cotton-candy", "Cotton Candy", "light", ["#f3efff", "#e8ddfa", "#fff8ff", "#d7c3eb", "#9176a9", "#37254e", "#65517c"],
    ["#7744b3", "#a03778", "#375bb9", "#247447", "#b23264", "#865615", "#246987"], 24),
  preset("campfire", "Campfire", "dark", ["#201713", "#2d2119", "#38291f", "#554034", "#9b7256", "#fff1df", "#d5b79c"],
    ["#ffb67d", "#dd8988", "#ffd186", "#a8cb8a", "#ff9c8d", "#ffe076", "#9bd0e8"], 9),
  preset("lemon-sorbet", "Lemon Sorbet", "light", ["#fff8db", "#f8edbe", "#fffbed", "#e1d18f", "#8e8050", "#38321e", "#61583a"],
    ["#816000", "#5d638a", "#6c7020", "#3d712a", "#ad383c", "#895006", "#265e81"], 18),
  preset("nebula", "Nebula", "dark", ["#0e1026", "#151936", "#201f44", "#3b4270", "#7285bc", "#f2f0ff", "#bdc0e6"],
    ["#a7a3ff", "#8be2e8", "#e6a2ff", "#85deba", "#ffa1ba", "#ffcf96", "#90bfff"], 14),
  preset("mint-chip", "Mint Chip", "light", ["#eaf9f3", "#d8f0e5", "#f6fffb", "#abd7c4", "#588674", "#273c34", "#466255"],
    ["#1f6d54", "#73503b", "#176e70", "#267346", "#a73555", "#895218", "#2c617d"], 15),
  preset("pixel-party", "Pixel Party", "dark", ["#1a1929", "#24233b", "#2c2c48", "#48496a", "#7c83a6", "#fff4f2", "#c8bbd8"],
    ["#ffac70", "#9fe791", "#9aafff", "#80e0ad", "#ff9a98", "#ffe16a", "#90e7ff"], 2),
  preset("pool-party", "Pool Party", "light", ["#e8f9fc", "#d0edf5", "#f5fdff", "#a5d6e2", "#588599", "#1d3846", "#416276"],
    ["#12658b", "#8f376a", "#226e77", "#2c7448", "#af344d", "#865514", "#2453a0"], 20),
  preset("blacklight", "Blacklight", "dark", ["#160d22", "#20122f", "#2c1941", "#4d346b", "#8864a6", "#faefff", "#ceafd9"],
    ["#b3f66c", "#c29aff", "#f7a0ed", "#83f4ac", "#ff91ae", "#ffd383", "#86e1ff"], 6),
];

export const builtInThemes = [
  defaultTheme,
  preset("dark", "Dark", "dark", ["#15171d", "#1b1e26", "#20242e", "#363e50", "#606e86"], darkSwatches),
  preset("light", "Light", "light", ["#f8faff", "#eef1f8", "#ffffff", "#d5dbe8", "#7e899e"], lightSwatches),
  preset("corporate", "Corporate", "light", ["#fafbfd", "#eff2f6", "#ffffff", "#d4dbe5", "#7c8799"],
    ["#397bf4", "#6e7284", "#c43179", "#477800", "#ca3150", "#856000", "#00796f"], 6),
  preset("cupcake", "Cupcake", "light", ["#fff9f4", "#f6eae5", "#fffdfa", "#e4d1cf", "#8d7580"],
    ["#007f78", "#ad5a0a", "#874cc1", "#207a40", "#bf3549", "#9d5800", "#236e8c"], 16),
  preset("cyberpunk", "Cyberpunk", "dark", ["#19171d", "#211d29", "#272230", "#494052", "#786985"],
    ["#c1eb36", "#ad7aff", "#ff76d2", "#80ca79", "#ff7b82", "#ffad56", "#63c8ff"], 4),
  preset("dim", "Dim", "dark", ["#222934", "#292f3a", "#303744", "#465062", "#71819a"],
    ["#7baaff", "#a996ce", "#f18bd9", "#75ca95", "#ff8b87", "#ffc37d", "#70cfff"]),
  preset("dracula", "Dracula", "dark", ["#20212c", "#272837", "#2c2e40", "#484a62", "#766f9a"],
    ["#bc9afa", "#f090be", "#cd8bfa", "#83e099", "#ff8e94", "#ffc986", "#8fe9f1"], 12),
  preset("ghibli", "Ghibli", "light", ["#f7eedb", "#eee3ca", "#fff8e9", "#d4c6a7", "#8b7957"],
    ["#586c26", "#526179", "#008073", "#4c741a", "#bc3740", "#8e5e00", "#285faa"], 13),
  preset("midnight", "Midnight", "dark", ["#0e1627", "#131d34", "#192743", "#34466b", "#657ca7"],
    ["#94afff", "#baa5fc", "#8ea5ee", "#73d9b8", "#ff9caa", "#f2c377", "#71ccf8"], 12),
  preset("forest", "Forest", "dark", ["#151e19", "#1b2921", "#233329", "#3c5347", "#648579"],
    ["#8bdb9d", "#c5bd7c", "#a0d1bd", "#8be1ad", "#ff9a91", "#edcb83", "#8bd3cf"], 8),
  preset("sandstone", "Sandstone", "light", ["#f8f0e5", "#eee0d2", "#fff8ef", "#d8c6b6", "#937c6e"],
    ["#945031", "#71596e", "#995141", "#496b33", "#ae373d", "#855400", "#386782"], 8),
  preset("nord", "Nord", "dark", ["#252c38", "#2d3543", "#353e4f", "#505c70", "#8494ae"],
    ["#9cd5ee", "#b6aacd", "#a4c4eb", "#b5d59e", "#ff9da8", "#f8d38f", "#a7dadd"]),
  preset("lavender", "Lavender", "light", ["#f9f6ff", "#eee8fa", "#fffcff", "#d9ccec", "#8872a5"],
    ["#6c48ad", "#985488", "#515bbb", "#327649", "#ac3a66", "#88530d", "#256e97"], 18),
  preset("ocean", "Ocean", "dark", ["#111e2a", "#162734", "#1e3141", "#374f62", "#608197"],
    ["#74daeb", "#82b1f6", "#8dcddf", "#70d4af", "#ff909a", "#f8c479", "#7ec6ff"], 12),
  preset("high-contrast", "High Contrast", "dark", ["#000000", "#121212", "#181818", "#828282", "#b0b0b0"],
    ["#fefe56", "#ffffff", "#97c9ff", "#87fc9d", "#ffa6ab", "#ffd67b", "#9adfff"], 2),
  preset("paper", "Paper", "light", ["#fbfaf6", "#efede4", "#ffffff", "#d5d2c7", "#817e73"],
    ["#435573", "#636775", "#5d4a6e", "#32652e", "#a1323b", "#81550d", "#216380"], 3),
  preset("oled", "OLED", "dark", ["#000000", "#0a0a10", "#13131a", "#333343", "#696983", "#f1effa", "#b5b3c9"],
    ["#c0c0ff", "#a7a3bd", "#c2aaf9", "#8bddac", "#ff99a5", "#f8cd8c", "#90d4ee"], 8),
  preset("rosewood", "Rosewood", "dark", ["#21171c", "#2a1e25", "#352732", "#554050", "#907086", "#faf0f6", "#cab6c4"],
    ["#e9add1", "#b4a6da", "#ecb2a6", "#a0d9b2", "#ff92a2", "#f1c481", "#9fcce8"], 12),
  preset("mist", "Mist", "light", ["#edf4fa", "#dfeaf3", "#f8fbfe", "#c1d2df", "#738595", "#25394a", "#4e6173"],
    ["#315c8f", "#57647f", "#376b80", "#31734c", "#ab3d59", "#815919", "#26538a"], 12),
  preset("espresso", "Espresso", "dark", ["#1b1512", "#26201b", "#302720", "#4b3b32", "#917562", "#faeee4", "#c9b7a9"],
    ["#e7b387", "#c0a0aa", "#deb98a", "#a7d298", "#ff9e94", "#f3d18a", "#98c8db"], 8),
  preset("terracotta", "Terracotta", "light", ["#f8ede5", "#eedbcf", "#fff8f1", "#d7b8a6", "#a37b68", "#452e26", "#6e5046"],
    ["#9b472f", "#785876", "#9d4b46", "#4e6f38", "#b72d45", "#875618", "#2f6385"], 10),
  ...playfulThemes,
];

const storageKey = "vnx.chat:appearance";
const legacyKey = "vnx.chat:theme";
const legacyThemes = new Map([
  ["light", "light"], ["dark", "dark"], ["BurntWood", "dark"], ["Hacker", "dark"],
  ["PurpleDaydream", "dark"], ["BloodRed", "dark"],
]);
const maxNameLength = 40;
const hexColor = /^#[\da-f]{6}$/i;
let session: Appearance | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseTheme(value: unknown): Theme | undefined {
  const data = record(value);
  if (!data) return;
  const { scheme, radius, density, textSize } = data;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const palette = record(data.colors);
  if (!name || name.length > maxNameLength || !palette || (scheme !== "light" && scheme !== "dark")
    || !integerInRange(radius, 0, 24) || !integerInRange(textSize, 90, 130)
    || (density !== "compact" && density !== "comfortable" && density !== "spacious")) return;

  const colors = { ...defaultTheme.colors };
  for (const [key] of colorFields) {
    const color = palette[key];
    if (typeof color !== "string" || !hexColor.test(color)) return;
    colors[key] = color.toLowerCase();
  }
  return { name, scheme, colors, radius, density, textSize };
}

export function themeFor(appearance: Appearance): SavedTheme {
  return builtInThemes.find(({ id }) => id === appearance.active)
    ?? appearance.custom.find(({ id }) => id === appearance.active) ?? defaultTheme;
}

export function readAppearance(): Appearance {
  if (session) return session;
  if (browser) {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const data = record(JSON.parse(saved));
        if (data?.version === 1) {
          const custom = new Map<string, SavedTheme>();
          for (const entry of Array.isArray(data.custom) ? data.custom : []) {
            const id = record(entry)?.id;
            const theme = parseTheme(entry);
            if (theme && typeof id === "string" && /^custom-[\da-f-]{36}$/.test(id)) custom.set(id, { ...theme, id });
          }
          const appearance = {
            active: typeof data.active === "string" ? data.active : "",
            custom: [...custom.values()],
            glassmorphism: data.glassmorphism === true,
          };
          appearance.active = themeFor(appearance).id;
          return appearance;
        }
      }
      return {
        active: legacyThemes.get(localStorage.getItem(legacyKey) ?? "") ?? defaultTheme.id,
        custom: [],
        glassmorphism: false,
      };
    } catch {
      // An unavailable or damaged preference store falls back to the default appearance.
    }
  }
  return { active: defaultTheme.id, custom: [], glassmorphism: false };
}

function luminance(color: string) {
  const channels = [1, 3, 5].map((start) => {
    const srgb = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrast(first: string, second: string) {
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function onColor(color: string) {
  return luminance(color) > 0.179 ? "#000000" : "#ffffff";
}

function properties(theme: Theme) {
  const { colors, radius, density, textSize, scheme } = theme;
  const densityValues = { compact: [32, 10], comfortable: [36, 14], spacious: [44, 18] } as const;
  const [height, gap] = densityValues[density];
  return {
    "color-scheme": scheme,
    "--background": colors.background,
    "--foreground": colors.text,
    "--card": colors.surface,
    "--muted": colors.panel,
    "--muted-foreground": colors.mutedText,
    "--primary": colors.primary,
    "--primary-foreground": theme === defaultTheme ? colors.background : onColor(colors.primary),
    "--secondary": colors.secondary,
    "--secondary-foreground": onColor(colors.secondary),
    "--accent": colors.accent,
    "--accent-foreground": onColor(colors.accent),
    "--success": colors.success,
    "--destructive": colors.danger,
    "--warning": colors.warning,
    "--info": colors.info,
    "--border": colors.border,
    "--input": colors.input,
    "--radius": radius + "px",
    "--control-height": height + "px",
    "--ui-gap": gap + "px",
    "--text-scale": String(textSize / 100),
  };
}

export function themeStyle(theme: Theme) {
  return Object.entries(properties(theme)).map(([key, value]) => key + ":" + value).join(";");
}

export function applyAppearance(appearance: Appearance, theme: Theme = themeFor(appearance)) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme.scheme === "dark");
  root.toggleAttribute("data-glass", appearance.glassmorphism);
  for (const [key, value] of Object.entries(properties(theme))) root.style.setProperty(key, value);

  const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
  if (favicon) {
    const tintedLogo = logo.replace("<svg ", `<svg style="--foreground:${theme.colors.text};--primary:${theme.colors.primary}" `);
    favicon.href = `data:image/svg+xml,${encodeURIComponent(tintedLogo)}`;
  }
}

export function saveAppearance(appearance: Appearance): boolean {
  session = appearance;
  applyAppearance(appearance);
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...appearance }));
    return true;
  } catch {
    return false;
  }
}
