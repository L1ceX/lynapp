import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExternalImportProgress, ExternalImportResult, ExternalInstance, ExternalLauncher, ExternalLauncherId, LauncherInstance, ModLoader } from "@shared/types";
import { tr } from "../i18n";
import type { ContentService } from "./content";
import type { InstanceService } from "./instances";
import type { MinecraftService } from "./minecraft";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const execFileAsync = promisify(execFile);
const PRISM_LIKE: Array<{ id: "prism" | "polymc" | "multimc"; exe: string; config: string }> = [
  { id: "prism", exe: "prismlauncher.exe", config: "prismlauncher.cfg" },
  { id: "polymc", exe: "polymc.exe", config: "polymc.cfg" },
  { id: "multimc", exe: "MultiMC.exe", config: "multimc.cfg" }
];
const SEARCH_LIMIT = 400;

const KNOWN_LOADERS: ModLoader[] = ["vanilla", "fabric", "forge", "quilt", "neoforge"];
const ICON_LIMIT = 512 * 1024;
const FULL_COPY_SKIP = new Set(["logs", "crash-reports"]);
const MINECRAFT_WHITELIST = new Set([
  "mods",
  "resourcepacks",
  "texturepacks",
  "shaderpacks",
  "saves",
  "config",
  "defaultconfigs",
  "datapacks",
  "screenshots",
  "schematics",
  "journeymap",
  "xaerowaypoints",
  "xaeroworldmap",
  "options.txt",
  "optionsof.txt",
  "optionsshaders.txt",
  "servers.dat"
]);

interface ScannedInstance extends ExternalInstance {
  copyMode: "full" | "whitelist";
}

interface ScannedLauncher extends Omit<ExternalLauncher, "instances"> {
  instances: ScannedInstance[];
}

function appData(): string {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function toLoader(value: string | undefined | null): ModLoader | null {
  const normalized = (value ?? "").toLowerCase().trim();
  return (KNOWN_LOADERS as string[]).includes(normalized) ? (normalized as ModLoader) : null;
}

function fromEpoch(value: unknown): string | undefined {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const ms = number < 1e12 ? number * 1000 : number;
  return new Date(ms).toISOString();
}

function fromDateString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

function parseIni(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=#;[\s][^=]*?)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
    result[match[1]] = value;
  }
  return result;
}

async function countEntries(dir: string, accept: (name: string, isDir: boolean) => boolean): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => accept(entry.name, entry.isDirectory())).length;
  } catch {
    return 0;
  }
}

async function contentCounts(gameDir: string): Promise<{ mods: number; worlds: number }> {
  const [mods, worlds] = await Promise.all([
    countEntries(path.join(gameDir, "mods"), (name, isDir) => !isDir && /\.jar(\.disabled)?$/i.test(name)),
    countEntries(path.join(gameDir, "saves"), (_name, isDir) => isDir)
  ]);
  return { mods, worlds };
}

async function iconToDataUrl(file: string | undefined | null): Promise<string | undefined> {
  if (!file) return undefined;
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : null;
  if (!mime) return undefined;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > ICON_LIMIT) return undefined;
    return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function normalizeRoot(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

const LOCATE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$names = @('prismlauncher.exe', 'polymc.exe', 'multimc.exe')",
  "$exe = New-Object System.Collections.Generic.List[string]",
  "Get-Process prismlauncher, polymc, multimc -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $exe.Add($_.Path) } }",
  "foreach ($key in @('HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache', 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Compatibility Assistant\\Store')) {",
  "  try { (Get-Item -LiteralPath $key -ErrorAction Stop).Property | ForEach-Object { $p = $_ -replace '\\.(FriendlyAppName|ApplicationCompany)$', ''; try { if ($names -contains [System.IO.Path]::GetFileName($p).ToLower()) { $exe.Add($p) } } catch { } } } catch { }",
  "}",
  "$ws = New-Object -ComObject WScript.Shell",
  "foreach ($dir in @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {",
  "  if ($dir -and (Test-Path -LiteralPath $dir)) { Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { try { $t = $ws.CreateShortcut($_.FullName).TargetPath; if ($t -and ($names -contains [System.IO.Path]::GetFileName($t).ToLower())) { $exe.Add($t) } } catch { } } }",
  "}",
  "foreach ($u in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {",
  "  Get-ItemProperty $u -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Prism|PolyMC|MultiMC' -and $_.InstallLocation } | ForEach-Object { $exe.Add((Join-Path $_.InstallLocation 'launcher.exe')) }",
  "}",
  "$shell = New-Object -ComObject Shell.Application",
  "$folders = @('shell:Downloads', 'shell:Desktop', 'shell:Personal') | ForEach-Object { try { $shell.NameSpace($_).Self.Path } catch { } } | Where-Object { $_ }",
  "@{ exe = @($exe | Select-Object -Unique); folders = @($folders) } | ConvertTo-Json -Compress"
].join("\n");

const SKIP_TOP = new Set(["windows", "$recycle.bin", "system volume information", "programdata", "recovery", "perflogs", "$windows.~bt", "$windows.~ws"]);

async function windowsLocations(): Promise<{ exe: string[]; folders: string[] }> {
  if (process.platform !== "win32") return { exe: [], folders: [] };
  try {
    const encoded = Buffer.from(LOCATE_SCRIPT, "utf16le").toString("base64");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 20000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim() || "{}") as { exe?: string[] | string; folders?: string[] | string };
    const list = (value: string[] | string | undefined): string[] => (Array.isArray(value) ? value : value ? [value] : []);
    return { exe: list(parsed.exe), folders: list(parsed.folders) };
  } catch {
    return { exe: [], folders: [] };
  }
}

function prismLikeAt(dir: string): (typeof PRISM_LIKE)[number] | null {
  for (const kind of PRISM_LIKE) {
    if (existsSync(path.join(dir, kind.config)) || existsSync(path.join(dir, kind.exe))) {
      const portable = kind.id === "multimc" || existsSync(path.join(dir, "portable.txt")) || existsSync(path.join(dir, "instances"));
      if (portable) return kind;
    }
  }
  return null;
}

async function scanShallow(base: string, depth: number, roots: Set<string>, skipTop: boolean): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, SEARCH_LIMIT)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (skipTop && SKIP_TOP.has(entry.name.toLowerCase())) continue;
    const dir = path.join(base, entry.name);
    if (prismLikeAt(dir)) {
      roots.add(dir);
      continue;
    }
    if (depth > 1) await scanShallow(dir, depth - 1, roots, false);
  }
}

async function findPortableRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const locations = windowsLocations();
  const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs");
  const drives = process.platform === "win32" ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive)) : [];
  const defaults = [path.join(os.homedir(), "Downloads"), path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Documents"), localPrograms];
  await Promise.all([
    ...defaults.map((base) => scanShallow(base, 2, roots, false)),
    ...drives.map((drive) => scanShallow(drive, 2, roots, true))
  ]);
  const { exe, folders } = await locations;
  for (const file of exe) {
    const dir = path.dirname(file);
    if (existsSync(dir) && prismLikeAt(dir)) roots.add(dir);
  }
  const known = new Set(defaults.map(normalizeRoot));
  await Promise.all(folders.filter((folder) => !known.has(normalizeRoot(folder))).map((base) => scanShallow(base, 2, roots, false)));
  return [...roots];
}

function publicLauncher(launcher: ScannedLauncher): ExternalLauncher {
  return { ...launcher, instances: launcher.instances.map(({ copyMode, ...rest }) => rest) };
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
}

function tableColumns(db: SqliteDatabase, name: string): string[] {
  return (db.prepare(`pragma table_info(${name})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function neoForgeGameVersion(loaderVersion: string): string | undefined {
  const match = loaderVersion.match(/^(\d+)\.(\d+)\./);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 20) return undefined;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

interface VersionInfo {
  gameVersion?: string;
  loader: ModLoader;
  loaderVersion?: string;
}

function parseVersionId(id: string): VersionInfo | null {
  const trimmed = id.trim();
  let match = trimmed.match(/^fabric-loader-([^-]+)-(.+)$/i);
  if (match) return { loader: "fabric", loaderVersion: match[1], gameVersion: match[2] };
  match = trimmed.match(/^quilt-loader-([^-]+)-(.+)$/i);
  if (match) return { loader: "quilt", loaderVersion: match[1], gameVersion: match[2] };
  match = trimmed.match(/^(\d+\.\d+(?:\.\d+)?)-forge-?(\d[\w.]*)/i);
  if (match) return { loader: "forge", loaderVersion: match[2], gameVersion: match[1] };
  match = trimmed.match(/^neoforge-(\d[\w.-]*)$/i);
  if (match) return { loader: "neoforge", loaderVersion: match[1], gameVersion: neoForgeGameVersion(match[1]) };
  match = trimmed.match(/^(fabric|forge|neoforge|quilt|forgeoptifine|optifine|vanilla)\s+(\d+\.\d+(?:\.\d+)?)$/i);
  if (match) {
    const kind = match[1].toLowerCase();
    const loader: ModLoader = kind === "forgeoptifine" ? "forge" : kind === "optifine" ? "vanilla" : (kind as ModLoader);
    return { loader, gameVersion: match[2] };
  }
  match = trimmed.match(/^(\d+\.\d+(?:\.\d+)?)(?:-optifine.*)?$/i);
  if (match) return { loader: "vanilla", gameVersion: match[1] };
  return null;
}

interface VersionJsonLite {
  id?: string;
  inheritsFrom?: string;
  libraries?: Array<{ name?: string }>;
}

async function resolveVersionJson(root: string, id: string): Promise<VersionInfo | null> {
  const libraries: string[] = [];
  let current: string | undefined = id;
  let gameVersion: string | undefined;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const json: VersionJsonLite | null = await readJson<VersionJsonLite>(path.join(root, "versions", current, `${current}.json`));
    if (!json) break;
    for (const lib of json.libraries ?? []) {
      if (lib.name) libraries.push(lib.name);
    }
    if (!json.inheritsFrom) {
      gameVersion = json.id ?? current;
      break;
    }
    current = json.inheritsFrom;
  }
  if (!libraries.length && !gameVersion) return null;
  const find = (prefix: string): string | undefined => libraries.find((name) => name.toLowerCase().startsWith(prefix))?.split(":")[2];
  const fabric = find("net.fabricmc:fabric-loader:");
  if (fabric) return { loader: "fabric", loaderVersion: fabric, gameVersion };
  const quilt = find("org.quiltmc:quilt-loader:");
  if (quilt) return { loader: "quilt", loaderVersion: quilt, gameVersion };
  const neo = find("net.neoforged:neoforge:");
  if (neo) return { loader: "neoforge", loaderVersion: neo, gameVersion: gameVersion ?? neoForgeGameVersion(neo) };
  const forge = find("net.minecraftforge:forge:") ?? find("net.minecraftforge:fmlloader:");
  if (forge) {
    const short = gameVersion && forge.startsWith(`${gameVersion}-`) ? forge.slice(gameVersion.length + 1) : forge.split("-").slice(1).join("-") || forge;
    return { loader: "forge", loaderVersion: short, gameVersion };
  }
  return gameVersion ? { loader: "vanilla", gameVersion } : null;
}

export class ExternalImportService {
  constructor(
    private readonly instances: InstanceService,
    private readonly content: ContentService,
    private readonly minecraft: MinecraftService
  ) {}

  async scan(extraRoots: string[] = []): Promise<ExternalLauncher[]> {
    return (await this.scanInternal(extraRoots)).map(publicLauncher);
  }

  async scanFolder(folder: string): Promise<ExternalLauncher | null> {
    const found = await this.scanRoot(folder);
    return found ? publicLauncher(found) : null;
  }

  private async scanInternal(extraRoots: string[]): Promise<ScannedLauncher[]> {
    const roaming = appData();
    const tasks: Array<Promise<ScannedLauncher | null>> = [
      this.scanModrinth([path.join(roaming, "ModrinthApp"), path.join(roaming, "com.modrinth.theseus")]),
      this.scanPrism(path.join(roaming, "PrismLauncher"), "prism"),
      this.scanPrism(path.join(roaming, "PolyMC"), "polymc"),
      this.scanCurseForge(path.join(os.homedir(), "curseforge", "minecraft", "Instances")),
      this.scanMinecraft(path.join(roaming, ".minecraft")),
      ...(await findPortableRoots()).map((root) => this.scanPrism(root)),
      ...extraRoots.map((root) => this.scanRoot(root))
    ];
    const results = await Promise.all(tasks.map((task) => task.catch(() => null)));
    const seen = new Set<string>();
    return results.filter((item): item is ScannedLauncher => {
      if (!item) return false;
      const id = normalizeRoot(item.root);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private async scanRoot(folder: string): Promise<ScannedLauncher | null> {
    if (!folder || !existsSync(folder)) return null;
    if (existsSync(path.join(folder, "app.db"))) return this.scanModrinth([folder]);
    if (existsSync(path.join(folder, "launcher_profiles.json"))) return this.scanMinecraft(folder);
    if (existsSync(path.join(folder, "instance.cfg"))) return this.scanPrism(path.dirname(path.dirname(folder)), undefined, path.dirname(folder));
    if (PRISM_LIKE.some((kind) => existsSync(path.join(folder, kind.config)) || existsSync(path.join(folder, kind.exe)))) return this.scanPrism(folder);
    if (existsSync(path.join(folder, "minecraftinstance.json"))) return this.scanCurseForge(path.dirname(folder));
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(folder, entry.name));
    if (dirs.some((dir) => existsSync(path.join(dir, "minecraftinstance.json")))) return this.scanCurseForge(folder);
    if (dirs.some((dir) => existsSync(path.join(dir, "instance.cfg")))) return this.scanPrism(path.dirname(folder), undefined, folder);
    if (existsSync(path.join(folder, "Instances"))) return this.scanCurseForge(path.join(folder, "Instances"));
    return null;
  }

  private failure(id: ExternalLauncherId, root: string, error: unknown): ScannedLauncher {
    return { key: `${id}:${root}`, id, root, instances: [], error: error instanceof Error ? error.message : String(error) };
  }

  private async finish(base: Omit<ScannedInstance, "mods" | "worlds" | "issue">): Promise<ScannedInstance> {
    const counts = await contentCounts(base.directory);
    let issue: string | undefined;
    if (!base.gameVersion) {
      issue = tr("Could not detect the game version", "Не удалось определить версию игры");
    } else if (!base.loader) {
      issue = tr("This loader is not supported by lynapp", "Этот загрузчик lynapp не поддерживает");
    }
    return { ...base, ...counts, issue };
  }

  private async scanModrinth(roots: string[]): Promise<ScannedLauncher | null> {
    const root = roots.find((candidate) => existsSync(path.join(candidate, "app.db")));
    if (!root) return null;
    const temp = await mkdtemp(path.join(os.tmpdir(), "lynapp-modrinth-"));
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = path.join(root, `app.db${suffix}`);
        if (existsSync(source)) await copyFile(source, path.join(temp, `app.db${suffix}`));
      }
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(temp, "app.db"));
      try {
        let profilesRoot = path.join(root, "profiles");
        if (hasTable(db, "settings") && tableColumns(db, "settings").includes("custom_dir")) {
          const row = db.prepare("select custom_dir from settings limit 1").get() as { custom_dir?: string | null } | undefined;
          if (row?.custom_dir && existsSync(path.join(row.custom_dir, "profiles"))) profilesRoot = path.join(row.custom_dir, "profiles");
        }
        const rows: Array<{ id: string; path: string; name: string; game_version?: string; loader?: string; loader_version?: string | null; icon_path?: string | null; last_played?: number | null; overrides?: string | null }> = [];
        if (hasTable(db, "instances") && hasTable(db, "instance_content_sets")) {
          const overrides = hasTable(db, "instance_launch_overrides");
          rows.push(...(db.prepare(`select i.id, i.path, i.name, s.game_version, s.loader, s.loader_version, i.icon_path, i.last_played${overrides ? ", json(o.overrides) as overrides" : ""} from instances i left join instance_content_sets s on s.id = i.applied_content_set_id${overrides ? " left join instance_launch_overrides o on o.instance_id = i.id" : ""} where i.install_stage = 'installed'`).all() as typeof rows));
        } else if (hasTable(db, "profiles")) {
          const columns = tableColumns(db, "profiles");
          const pick = (name: string, alias: string): string => (columns.includes(name) ? `${name} as ${alias}` : `null as ${alias}`);
          rows.push(...(db.prepare(`select path as id, path, ${pick("name", "name")}, ${pick("game_version", "game_version")}, ${pick("mod_loader", "loader")}, ${pick("mod_loader_version", "loader_version")}, ${pick("icon_path", "icon_path")}, ${pick("last_played", "last_played")} from profiles`).all() as typeof rows));
        }
        const instances = await Promise.all(rows.map(async (row) => {
          let maxMemoryMb: number | undefined;
          let extraJvmArgs: string | undefined;
          if (row.overrides) {
            try {
              const parsed = JSON.parse(row.overrides) as { memory?: { maximum?: number }; extra_launch_args?: string[] };
              if (typeof parsed.memory?.maximum === "number" && parsed.memory.maximum >= 512) maxMemoryMb = Math.round(parsed.memory.maximum);
              if (Array.isArray(parsed.extra_launch_args) && parsed.extra_launch_args.length) extraJvmArgs = parsed.extra_launch_args.join(" ");
            } catch {
            }
          }
          return this.finish({
            key: `modrinth:${root}|${row.id}`,
            launcher: "modrinth",
            name: row.name || row.path,
            gameVersion: row.game_version ?? "",
            loader: toLoader(row.loader),
            loaderVersion: row.loader_version || undefined,
            directory: path.join(profilesRoot, row.path),
            lastPlayed: fromEpoch(row.last_played),
            iconDataUrl: await iconToDataUrl(row.icon_path),
            maxMemoryMb,
            extraJvmArgs,
            copyMode: "full"
          });
        }));
        return { key: `modrinth:${root}`, id: "modrinth", root, instances: instances.filter((item) => existsSync(item.directory)) };
      } finally {
        db.close();
      }
    } catch (error) {
      return this.failure("modrinth", root, error);
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async scanPrism(root: string, forced?: "prism" | "polymc" | "multimc", instancesOverride?: string): Promise<ScannedLauncher | null> {
    if (!existsSync(root)) return null;
    const kind = PRISM_LIKE.find((item) => item.id === forced) ?? PRISM_LIKE.find((item) => existsSync(path.join(root, item.config)) || existsSync(path.join(root, item.exe))) ?? PRISM_LIKE[0];
    const id = kind.id;
    try {
      let instancesDir = instancesOverride ?? path.join(root, "instances");
      if (!instancesOverride) {
        try {
          const config = parseIni(await readFile(path.join(root, kind.config), "utf8"));
          if (config.InstanceDir) instancesDir = path.isAbsolute(config.InstanceDir) ? config.InstanceDir : path.join(root, config.InstanceDir);
        } catch {
        }
      }
      const entries = await readdir(instancesDir, { withFileTypes: true }).catch(() => []);
      const instances: ScannedInstance[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(instancesDir, entry.name);
        let cfg: Record<string, string>;
        try {
          cfg = parseIni(await readFile(path.join(dir, "instance.cfg"), "utf8"));
        } catch {
          continue;
        }
        const pack = await readJson<{ components?: Array<{ uid?: string; version?: string }> }>(path.join(dir, "mmc-pack.json"));
        const components = pack?.components ?? [];
        const version = (uid: string): string | undefined => components.find((component) => component.uid === uid)?.version;
        const loaders: Array<[string, ModLoader]> = [["net.fabricmc.fabric-loader", "fabric"], ["org.quiltmc.quilt-loader", "quilt"], ["net.neoforged", "neoforge"], ["net.minecraftforge", "forge"]];
        const found = loaders.find(([uid]) => version(uid));
        const unsupported = components.some((component) => component.uid === "com.mumfrey.liteloader");
        const gameDir = [".minecraft", "minecraft"].map((name) => path.join(dir, name)).find((candidate) => existsSync(candidate)) ?? path.join(dir, ".minecraft");
        const iconKey = cfg.iconKey && cfg.iconKey !== "default" ? cfg.iconKey : "";
        let iconFile: string | undefined;
        if (iconKey) {
          const icons = await readdir(path.join(root, "icons")).catch(() => [] as string[]);
          const match = icons.find((file) => path.parse(file).name === iconKey);
          if (match) iconFile = path.join(root, "icons", match);
        }
        const memory = cfg.OverrideMemory === "true" ? Number(cfg.MaxMemAlloc) : NaN;
        instances.push(await this.finish({
          key: `${id}:${instancesDir}|${entry.name}`,
          launcher: id,
          name: cfg.name || entry.name,
          gameVersion: version("net.minecraft") ?? "",
          loader: unsupported ? null : found ? found[1] : "vanilla",
          loaderVersion: found ? version(found[0]) : undefined,
          directory: gameDir,
          lastPlayed: fromEpoch(cfg.lastLaunchTime),
          iconDataUrl: await iconToDataUrl(iconFile),
          maxMemoryMb: Number.isFinite(memory) && memory >= 512 ? Math.round(memory) : undefined,
          extraJvmArgs: cfg.OverrideJavaArgs === "true" && cfg.JvmArgs ? cfg.JvmArgs : undefined,
          copyMode: "full"
        }));
      }
      return { key: `${id}:${instancesDir}`, id, root: instancesDir, instances };
    } catch (error) {
      return this.failure(id, root, error);
    }
  }

  private async scanCurseForge(root: string): Promise<ScannedLauncher | null> {
    if (!existsSync(root)) return null;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const instances: ScannedInstance[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const manifest = await readJson<{ name?: string; gameVersion?: string; lastPlayed?: string; allocatedMemory?: number; javaArgsOverride?: string; baseModLoader?: { name?: string; minecraftVersion?: string } | null }>(path.join(dir, "minecraftinstance.json"));
        if (!manifest) continue;
        const loaderName = manifest.baseModLoader?.name ?? "";
        const [kind, loaderVersion] = loaderName.split("-");
        const loader = loaderName ? toLoader(kind) : "vanilla";
        instances.push(await this.finish({
          key: `curseforge:${root}|${entry.name}`,
          launcher: "curseforge",
          name: manifest.name || entry.name,
          gameVersion: manifest.gameVersion || manifest.baseModLoader?.minecraftVersion || "",
          loader,
          loaderVersion: loaderName ? loaderVersion : undefined,
          directory: dir,
          lastPlayed: fromDateString(manifest.lastPlayed),
          maxMemoryMb: typeof manifest.allocatedMemory === "number" && manifest.allocatedMemory >= 512 ? Math.round(manifest.allocatedMemory) : undefined,
          extraJvmArgs: manifest.javaArgsOverride?.trim() || undefined,
          copyMode: "full"
        }));
      }
      return { key: `curseforge:${root}`, id: "curseforge", root, instances };
    } catch (error) {
      return this.failure("curseforge", root, error);
    }
  }

  private async scanMinecraft(root: string): Promise<ScannedLauncher | null> {
    if (!existsSync(path.join(root, "launcher_profiles.json"))) return null;
    try {
      const profiles = (await readJson<{ profiles?: Record<string, { name?: string; type?: string; lastVersionId?: string; gameDir?: string; javaArgs?: string; lastUsed?: string; icon?: string }> }>(path.join(root, "launcher_profiles.json")))?.profiles ?? {};
      const instances: ScannedInstance[] = [];
      let latestRelease: string | undefined;
      for (const [profileId, profile] of Object.entries(profiles)) {
        if (profile.type === "latest-snapshot") continue;
        let versionId = profile.lastVersionId ?? "";
        if (profile.type === "latest-release" || versionId === "latest-release") {
          latestRelease ??= (await this.minecraft.listReleaseVersions().catch(() => [] as string[]))[0];
          versionId = latestRelease ?? "";
        }
        const info = (versionId && (await resolveVersionJson(root, versionId))) || parseVersionId(versionId);
        const gameDir = profile.gameDir && existsSync(profile.gameDir) ? profile.gameDir : root;
        const memoryMatch = profile.javaArgs?.match(/-Xmx(\d+)([GgMm])/);
        const memory = memoryMatch ? Number(memoryMatch[1]) * (memoryMatch[2].toLowerCase() === "g" ? 1024 : 1) : NaN;
        const name = profile.name?.trim() || (profile.type === "latest-release" ? tr("Latest release", "Последний релиз") : versionId || profileId);
        instances.push(await this.finish({
          key: `minecraft:${root}|${profileId}`,
          launcher: "minecraft",
          name,
          gameVersion: info?.gameVersion ?? "",
          loader: info ? info.loader : null,
          loaderVersion: info?.loaderVersion,
          directory: gameDir,
          lastPlayed: fromDateString(profile.lastUsed),
          iconDataUrl: profile.icon?.startsWith("data:image/") && profile.icon.length < ICON_LIMIT ? profile.icon : undefined,
          maxMemoryMb: Number.isFinite(memory) && memory >= 512 ? memory : undefined,
          copyMode: "whitelist"
        }));
      }
      return instances.length ? { key: `minecraft:${root}`, id: "minecraft", root, instances } : null;
    } catch (error) {
      return this.failure("minecraft", root, error);
    }
  }

  private async copyGameDir(item: ScannedInstance, target: string): Promise<void> {
    if (!existsSync(item.directory)) return;
    const source = item.directory;
    await cp(source, target, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
      filter: (src) => {
        const rel = path.relative(source, src);
        if (!rel) return true;
        if (path.basename(src) === "session.lock") return false;
        const top = rel.split(path.sep)[0].toLowerCase();
        if (item.copyMode === "whitelist") return MINECRAFT_WHITELIST.has(top);
        return !FULL_COPY_SKIP.has(top);
      }
    });
  }

  async importInstances(keys: string[], extraRoots: string[], onProgress: (update: ExternalImportProgress) => void): Promise<ExternalImportResult> {
    const launchers = await this.scanInternal(extraRoots);
    const byKey = new Map(launchers.flatMap((launcher) => launcher.instances).map((item) => [item.key, item]));
    const result: ExternalImportResult = { imported: [], failed: [] };
    const total = keys.length;
    for (const [index, key] of keys.entries()) {
      const item = byKey.get(key);
      if (!item) {
        result.failed.push({ key, name: key, reason: tr("The instance is no longer available", "Инстанция больше не найдена") });
        onProgress({ key, index, total, phase: "failed" });
        continue;
      }
      if (item.issue || !item.loader || !item.gameVersion) {
        result.failed.push({ key, name: item.name, reason: item.issue ?? tr("Unsupported instance", "Инстанция не поддерживается") });
        onProgress({ key, index, total, phase: "failed", message: item.issue });
        continue;
      }
      let created: LauncherInstance | null = null;
      try {
        onProgress({ key, index, total, phase: "create" });
        created = await this.instances.create({ name: item.name, gameVersion: item.gameVersion, loader: item.loader, loaderVersion: item.loaderVersion });
        onProgress({ key, index, total, phase: "copy" });
        await this.copyGameDir(item, created.directory);
        if (item.maxMemoryMb || item.extraJvmArgs) {
          created = await this.instances.updateInstance({ id: created.id, patch: { maxMemoryMb: item.maxMemoryMb, extraJvmArgs: item.extraJvmArgs } });
        }
        onProgress({ key, index, total, phase: "detect" });
        await this.content.detectFromModrinth(created.id).catch(() => undefined);
        result.imported.push({ key, instanceId: created.id, name: created.name });
        onProgress({ key, index, total, phase: "done" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (created) await this.instances.remove(created.id).catch(() => undefined);
        result.failed.push({ key, name: item.name, reason });
        onProgress({ key, index, total, phase: "failed", message: reason });
      }
    }
    return result;
  }
}
