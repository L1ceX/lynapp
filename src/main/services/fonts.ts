import { dialog, shell, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AddCustomFontResult, CustomFontInfo, GoogleFontInfo } from "@shared/types";
import { tr } from "../i18n";
import { getFontsRoot, getLauncherRoot } from "../paths";

const execFileAsync = promisify(execFile);
const MAX_CUSTOM_FONT_BYTES = 20 * 1024 * 1024;
const GOOGLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FONT_MIMES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".otf": "font/otf",
  ".ttf": "font/ttf"
};

function cleanFontDisplayName(stem: string): string {
  const normalized = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || "Custom Font";
}

function sanitizeStem(input: string): string {
  const cleaned = input
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 64)
    .replace(/[ .]+$/g, "");
  return cleaned || "CustomFont";
}

async function readSingleCustomFont(fullPath: string): Promise<CustomFontInfo | null> {
  const info = await stat(fullPath).catch(() => null);
  if (!info || !info.isFile() || info.size === 0 || info.size > MAX_CUSTOM_FONT_BYTES) {
    return null;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mime = FONT_MIMES[ext];
  if (!mime) return null;
  const fileName = path.basename(fullPath);
  const stem = path.basename(fullPath, path.extname(fullPath));
  const buf = await readFile(fullPath).catch(() => null);
  if (!buf) return null;
  return {
    id: `custom:${fileName}`,
    name: cleanFontDisplayName(stem),
    fileName,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`
  };
}

export async function listCustomFonts(): Promise<CustomFontInfo[]> {
  const dir = getFontsRoot();
  const entries = await readdir(dir).catch(() => [] as string[]);
  const list: CustomFontInfo[] = [];
  for (const entry of entries) {
    const item = await readSingleCustomFont(path.join(dir, entry));
    if (item) list.push(item);
  }
  list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.fileName.toLowerCase().localeCompare(b.fileName.toLowerCase()));
  return list;
}

export async function addCustomFont(parent?: BrowserWindow): Promise<AddCustomFontResult | null> {
  const options = {
    title: tr("Select font file", "Выберите файл шрифта"),
    filters: [{ name: tr("Font files", "Файлы шрифтов"), extensions: ["ttf", "otf", "woff", "woff2"] }],
    properties: ["openFile"] as Array<"openFile">
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) {
    return null;
  }
  const src = picked.filePaths[0];
  const info = await stat(src);
  if (!info.isFile()) {
    throw new Error(tr("Selected item is not a file", "Выбранный объект не является файлом"));
  }
  if (info.size === 0 || info.size > MAX_CUSTOM_FONT_BYTES) {
    throw new Error(tr("Font file must be between 1 byte and 20 MB", "Размер файла шрифта должен быть не больше 20 МБ"));
  }
  const ext = path.extname(src).toLowerCase();
  if (!FONT_MIMES[ext]) {
    throw new Error(tr("Unsupported font format. Use .ttf, .otf, .woff or .woff2", "Неподдерживаемый формат шрифта. Используйте .ttf, .otf, .woff или .woff2"));
  }
  const rawStem = path.basename(src, path.extname(src));
  const stem = sanitizeStem(rawStem);
  const dir = getFontsRoot();
  await mkdir(dir, { recursive: true });
  let dest = path.join(dir, `${stem}${ext}`);
  if (existsSync(dest)) {
    let placed = false;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = path.join(dir, `${stem} (${i})${ext}`);
      if (!existsSync(candidate)) {
        dest = candidate;
        placed = true;
        break;
      }
    }
    if (!placed) {
      dest = path.join(dir, `${stem}-${Date.now()}${ext}`);
    }
  }
  await copyFile(src, dest);
  const added = await readSingleCustomFont(dest);
  const fonts = await listCustomFonts();
  return { added, fonts };
}

export async function removeCustomFont(fileName: string): Promise<CustomFontInfo[]> {
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..") || path.basename(fileName) !== fileName) {
    throw new Error(tr("Invalid font file name", "Некорректное имя файла шрифта"));
  }
  const target = path.join(getFontsRoot(), fileName);
  const info = await stat(target).catch(() => null);
  if (info?.isFile()) {
    await rm(target, { force: true });
  }
  return listCustomFonts();
}

export async function openFontsFolder(): Promise<string> {
  const dir = getFontsRoot();
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return shell.openPath(dir);
}

export async function listSystemFonts(): Promise<string[]> {
  const unique = new Set<string>();
  try {
    if (process.platform === "win32") {
      const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; ([System.Drawing.Text.InstalledFontCollection]::new()).Families | ForEach-Object { $_.Name }";
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024
      });
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("@")) unique.add(trimmed);
      }
    } else {
      const { stdout } = await execFileAsync("fc-list", [":", "family"], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024
      });
      for (const line of stdout.split(/\r?\n/)) {
        for (const part of line.split(",")) {
          const trimmed = part.trim();
          if (trimmed && !trimmed.startsWith(".")) unique.add(trimmed);
        }
      }
    }
  } catch {
  }
  return Array.from(unique).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function parseGoogleFontsMetadata(raw: string): GoogleFontInfo[] {
  const trimmed = raw.trimStart();
  const body = trimmed.startsWith(")]}'") ? trimmed.slice(4).trimStart() : trimmed;
  const parsed = JSON.parse(body) as {
    familyMetadataList?: Array<{
      family?: string;
      category?: string;
      subsets?: string[];
      popularity?: number;
      fonts?: Record<string, unknown>;
    }>;
  };
  const items = parsed.familyMetadataList;
  if (!Array.isArray(items)) {
    throw new Error("Invalid Google Fonts metadata");
  }
  const out: GoogleFontInfo[] = [];
  for (const item of items) {
    const family = typeof item.family === "string" ? item.family.trim() : "";
    if (!family) continue;
    const category = typeof item.category === "string" ? item.category : "Sans Serif";
    const cyrillic = Array.isArray(item.subsets) && item.subsets.includes("cyrillic");
    const popularity = typeof item.popularity === "number" ? item.popularity : 99999;
    const weightSet = new Set<number>();
    if (item.fonts && typeof item.fonts === "object") {
      for (const key of Object.keys(item.fonts)) {
        if (key.endsWith("i")) continue;
        const num = Number.parseInt(key, 10);
        if (Number.isFinite(num) && num > 0) weightSet.add(num);
      }
    }
    const weights = Array.from(weightSet).sort((a, b) => a - b);
    if (weights.length === 0) weights.push(400);
    out.push({ family, category, cyrillic, popularity, weights });
  }
  out.sort((a, b) => a.popularity - b.popularity || a.family.toLowerCase().localeCompare(b.family.toLowerCase()));
  return out;
}

export async function listGoogleFonts(): Promise<GoogleFontInfo[]> {
  const cachePath = path.join(getLauncherRoot(), "cache", "google-fonts.json");
  let cached: GoogleFontInfo[] | null = null;
  try {
    const info = await stat(cachePath);
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as GoogleFontInfo[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      cached = parsed;
      if (Date.now() - info.mtimeMs < GOOGLE_CACHE_TTL_MS) {
        return parsed;
      }
    }
  } catch {
  }

  try {
    const response = await fetch("https://fonts.google.com/metadata/fonts", {
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    const list = parseGoogleFontsMetadata(text);
    await mkdir(path.dirname(cachePath), { recursive: true }).catch(() => undefined);
    await writeFile(cachePath, JSON.stringify(list), "utf8").catch(() => undefined);
    return list;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}
