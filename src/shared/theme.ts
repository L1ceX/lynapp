export type ThemeTokenId =
  | "background"
  | "sidebar"
  | "cards"
  | "inputs"
  | "borders"
  | "buttons"
  | "accent"
  | "active"
  | "primary"
  | "text"
  | "muted"
  | "danger"
  | "glow";

export type ThemeGroup = "Backgrounds" | "Accents" | "Text";

export interface ThemeTokenDef {
  id: ThemeTokenId;
  label: string;
  group: ThemeGroup;
  vars: string[];
  default: string;
}

export const THEME_TOKENS: ThemeTokenDef[] = [
  { id: "background", label: "Background", group: "Backgrounds", vars: ["--t-bg", "--t-page", "--t-workspace"], default: "#0b111d" },
  { id: "sidebar", label: "Sidebar", group: "Backgrounds", vars: ["--t-rail", "--t-sidebar"], default: "#0d1522" },
  { id: "cards", label: "Cards", group: "Backgrounds", vars: ["--t-surface", "--t-card", "--t-popup"], default: "#101d2e" },
  { id: "inputs", label: "Inputs", group: "Backgrounds", vars: ["--t-field"], default: "#0b1524" },
  { id: "borders", label: "Borders", group: "Accents", vars: ["--t-border"], default: "#21364e" },
  { id: "buttons", label: "Buttons", group: "Accents", vars: ["--t-button"], default: "#132137" },
  { id: "accent", label: "Accent", group: "Accents", vars: ["--t-accent"], default: "#4e8cc5" },
  { id: "active", label: "Active tabs", group: "Accents", vars: ["--t-accentbg"], default: "#1c4973" },
  { id: "primary", label: "Main buttons", group: "Accents", vars: ["--t-primary"], default: "#224e78" },
  { id: "danger", label: "Danger", group: "Accents", vars: ["--t-danger"], default: "#b96b82" },
  { id: "glow", label: "Cursor glow", group: "Accents", vars: [], default: "#ffffff" },
  { id: "text", label: "Text", group: "Text", vars: ["--t-text"], default: "#e8f0fb" },
  { id: "muted", label: "Secondary text", group: "Text", vars: ["--t-muted"], default: "#8ba2ba" }
];

export const THEME_GROUPS: ThemeGroup[] = ["Backgrounds", "Accents", "Text"];

export type ThemeValues = Record<ThemeTokenId, string>;

export const THEME_DEFAULTS: ThemeValues = Object.fromEntries(
  THEME_TOKENS.map((token) => [token.id, token.default])
) as ThemeValues;

export interface ThemePreset {
  id: string;
  label: string;
  values: ThemeValues;
}

const preset = (id: string, label: string, values: Partial<ThemeValues>): ThemePreset => ({
  id,
  label,
  values: { ...THEME_DEFAULTS, ...values }
});

export const THEME_PRESETS: ThemePreset[] = [
  preset("default", "Default", {}),
  preset("abyss", "Abyss", {
    background: "#05070c",
    sidebar: "#070c15",
    cards: "#0a1220",
    inputs: "#060c15",
    borders: "#1a2636",
    buttons: "#0d1622",
    accent: "#3d7dd1",
    active: "#12325c",
    primary: "#1a3f66",
    text: "#e6eefb",
    muted: "#7d8ea3",
    danger: "#b96b82",
    glow: "#ffffff"
  }),
  preset("ember", "Ember", {
    background: "#140f0d",
    sidebar: "#181210",
    cards: "#221715",
    inputs: "#170f0e",
    borders: "#4a3226",
    buttons: "#2b1d17",
    accent: "#e08a3c",
    active: "#6e3a15",
    primary: "#8a4d1c",
    text: "#fbf0e6",
    muted: "#b39d8a",
    danger: "#e05c5c",
    glow: "#ffb066"
  }),
  preset("forest", "Forest", {
    background: "#0b120d",
    sidebar: "#0f1a12",
    cards: "#15211a",
    inputs: "#0c140f",
    borders: "#2a4030",
    buttons: "#17251c",
    accent: "#5cb871",
    active: "#1d4a2a",
    primary: "#2a6b3c",
    text: "#ecf5ee",
    muted: "#8ba393",
    danger: "#e05c5c",
    glow: "#a8f0bc"
  }),
  preset("violet", "Violet", {
    background: "#100d18",
    sidebar: "#150f22",
    cards: "#1e1530",
    inputs: "#120d1c",
    borders: "#3a2d55",
    buttons: "#1e1630",
    accent: "#8f7bf0",
    active: "#3a2a6e",
    primary: "#5a3fa8",
    text: "#f1ebfb",
    muted: "#9d92b8",
    danger: "#f0607e",
    glow: "#c4b2ff"
  }),
  preset("arctic", "Arctic", {
    background: "#e9eef5",
    sidebar: "#dde4ee",
    cards: "#ffffff",
    inputs: "#ffffff",
    borders: "#c0c9d8",
    buttons: "#dfe6f0",
    accent: "#2f6fed",
    active: "#2f6fed",
    primary: "#2f6fed",
    text: "#16202e",
    muted: "#5c6b7e",
    danger: "#c73e5b",
    glow: "#2f6fed"
  })
];

export function resolveTheme(input?: Partial<ThemeValues> | null): ThemeValues {
  return { ...THEME_DEFAULTS, ...(input ?? {}) };
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(num)) return [255, 255, 255];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
