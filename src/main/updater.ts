import { app, shell, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { IPC } from "@shared/ipc";
import type { UpdateEdition, UpdateReleaseInfo, UpdateStatus } from "@shared/types";
import { tr } from "./i18n";
import { getLauncherRoot } from "./paths";

const GITHUB_RELEASES_URL = "https://api.github.com/repos/L1ceX/lynapp/releases?per_page=30";

interface GhAsset {
  name: string;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  assets?: GhAsset[];
}

interface PendingRelease {
  version: string;
  prerelease: boolean;
  htmlUrl: string;
  assetUrl: string | null;
  assetName: string | null;
}

let mainWindow: BrowserWindow | null = null;
let allowBeta: boolean | null = null;
let preferredEdition: UpdateEdition = "electron";
let checking = false;
let downloading = false;
let pendingTauri: PendingRelease | null = null;
let pendingElectron: PendingRelease | null = null;
let downloadedPath: string | null = null;

function parseSemver(raw: string): [number, number, number, string | null] | null {
  const trimmed = raw.trim().replace(/^v/i, "");
  const dash = trimmed.indexOf("-");
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const pre = dash === -1 ? null : trimmed.slice(dash + 1);
  const parts = core.split(".");
  const maj = Number.parseInt(parts[0] ?? "", 10);
  const min = Number.parseInt(parts[1] ?? "0", 10);
  const pat = Number.parseInt(parts[2] ?? "0", 10);
  if (!Number.isFinite(maj) || !Number.isFinite(min) || !Number.isFinite(pat)) return null;
  return [maj, min, pat, pre];
}

function comparePre(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i += 1) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined && y !== undefined) return -1;
    if (x !== undefined && y === undefined) return 1;
    if (x === undefined || y === undefined) break;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareSemver(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) return 0;
  if (sa[0] !== sb[0]) return sa[0] < sb[0] ? -1 : 1;
  if (sa[1] !== sb[1]) return sa[1] < sb[1] ? -1 : 1;
  if (sa[2] !== sb[2]) return sa[2] < sb[2] ? -1 : 1;
  if (sa[3] === null && sb[3] !== null) return 1;
  if (sa[3] !== null && sb[3] === null) return -1;
  if (sa[3] === null && sb[3] === null) return 0;
  return comparePre(sa[3]!, sb[3]!);
}

function pickSetupAsset(assets: GhAsset[]): GhAsset | null {
  if (process.platform === "win32") {
    return (
      assets.find((a) => {
        const n = a.name.toLowerCase();
        return n.endsWith(".exe") && n.includes("setup");
      }) ??
      assets.find((a) => {
        const n = a.name.toLowerCase();
        return n.endsWith(".exe") && !n.includes("portable");
      }) ??
      null
    );
  }
  return assets.find((a) => a.name.toLowerCase().endsWith(".appimage")) ?? null;
}

function toPending(rel: GhRelease): PendingRelease {
  const version = rel.tag_name.replace(/^v/i, "");
  const asset = pickSetupAsset(rel.assets ?? []);
  return {
    version,
    prerelease: rel.prerelease,
    htmlUrl: rel.html_url,
    assetUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null
  };
}

function summary(item: PendingRelease | null): UpdateReleaseInfo | null {
  return item ? { version: item.version, prerelease: item.prerelease } : null;
}

function send(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.updaterStatus, status);
  }
}

export function setupAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;
  if (allowBeta !== null) {
    void checkForUpdates();
  }
}

export function configureUpdater(beta: boolean, edition?: UpdateEdition): void {
  const nextEdition: UpdateEdition = edition === "tauri" ? "tauri" : "electron";
  const changed = allowBeta !== beta || preferredEdition !== nextEdition;
  allowBeta = beta;
  preferredEdition = nextEdition;
  if (changed && mainWindow) {
    void checkForUpdates();
  }
}

export function setBetaUpdates(enabled: boolean): void {
  configureUpdater(enabled, preferredEdition);
}

export async function checkForUpdates(): Promise<void> {
  if (!mainWindow || allowBeta === null || checking || downloading) {
    return;
  }
  checking = true;
  const beta = allowBeta;
  const edition = preferredEdition;
  send({
    kind: "checking",
    edition,
    latestTauri: summary(pendingTauri),
    latestElectron: summary(pendingElectron)
  });

  try {
    const resp = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `lynapp/${app.getVersion()}`
      },
      signal: AbortSignal.timeout(25000)
    });
    if (!resp.ok) {
      checking = false;
      send({
        kind: "error",
        edition,
        message: tr(`Update server returned HTTP ${resp.status}`, `Сервер обновлений вернул HTTP ${resp.status}`),
        latestTauri: summary(pendingTauri),
        latestElectron: summary(pendingElectron)
      });
      return;
    }
    const releases = (await resp.json()) as GhRelease[];
    let bestTauri: PendingRelease | null = null;
    let bestElectron: PendingRelease | null = null;
    for (const rel of releases) {
      if (rel.draft) continue;
      const ver = rel.tag_name.replace(/^v/i, "");
      const parsed = parseSemver(ver);
      if (!parsed) continue;
      const isPre = rel.prerelease || parsed[3] !== null;
      if (!beta && isPre) continue;
      const candidate = toPending(rel);
      if (parsed[0] >= 2) {
        if (!bestTauri || compareSemver(candidate.version, bestTauri.version) > 0) {
          bestTauri = candidate;
        }
      } else if (parsed[0] === 1) {
        if (!bestElectron || compareSemver(candidate.version, bestElectron.version) > 0) {
          bestElectron = candidate;
        }
      }
    }

    pendingTauri = bestTauri;
    pendingElectron = bestElectron;
    downloadedPath = null;
    checking = false;

    const lt = summary(bestTauri);
    const le = summary(bestElectron);
    if (edition === "tauri") {
      if (bestTauri) {
        send({ kind: "available", edition: "tauri", version: bestTauri.version, latestTauri: lt, latestElectron: le });
      } else {
        send({ kind: "up-to-date", edition: "tauri", latestTauri: lt, latestElectron: le });
      }
      return;
    }
    if (bestElectron && compareSemver(bestElectron.version, app.getVersion()) > 0) {
      send({ kind: "available", edition: "electron", version: bestElectron.version, latestTauri: lt, latestElectron: le });
    } else {
      send({ kind: "up-to-date", edition: "electron", latestTauri: lt, latestElectron: le });
    }
  } catch (error) {
    checking = false;
    send({
      kind: "error",
      edition,
      message: error instanceof Error ? error.message : String(error),
      latestTauri: summary(pendingTauri),
      latestElectron: summary(pendingElectron)
    });
  }
}

export async function downloadUpdate(edition?: UpdateEdition): Promise<void> {
  if (downloading) return;
  const targetEdition: UpdateEdition = edition === "tauri" || edition === "electron" ? edition : preferredEdition;
  const chosen = targetEdition === "tauri" ? pendingTauri : pendingElectron;
  if (!chosen) {
    throw new Error(tr("No update available", "Нет доступного обновления"));
  }
  const lt = summary(pendingTauri);
  const le = summary(pendingElectron);

  if (!chosen.assetUrl) {
    await shell.openExternal(chosen.htmlUrl);
    send({ kind: "available", edition: targetEdition, version: chosen.version, latestTauri: lt, latestElectron: le });
    return;
  }

  downloading = true;
  send({ kind: "downloading", edition: targetEdition, version: chosen.version, percent: 0, latestTauri: lt, latestElectron: le });

  const dir = path.join(getLauncherRoot(), "cache", "updates");
  await mkdir(dir, { recursive: true });
  const fileName = chosen.assetName ?? `lynapp-setup-${chosen.version}.exe`;
  const dest = path.join(dir, fileName);
  const tmp = `${dest}.part`;

  try {
    const resp = await fetch(chosen.assetUrl, {
      headers: { "User-Agent": `lynapp/${app.getVersion()}` },
      signal: AbortSignal.timeout(600000)
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const total = Number(resp.headers.get("content-length") ?? "0") || 0;
    const out = createWriteStream(tmp);
    const reader = Readable.fromWeb(resp.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    let received = 0;
    let lastEmit = 0;

    await new Promise<void>((resolve, reject) => {
      reader.on("data", (chunk: Buffer) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 150) {
          lastEmit = now;
          const percent = total > 0 ? Math.min(100, Math.round((received * 100) / total)) : 0;
          send({ kind: "downloading", edition: targetEdition, version: chosen.version, percent, latestTauri: lt, latestElectron: le });
        }
      });
      reader.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      reader.pipe(out);
    });

    await rm(dest, { force: true }).catch(() => undefined);
    await rename(tmp, dest);
    if (process.platform !== "win32") {
      await chmod(dest, 0o755).catch(() => undefined);
    }
    downloadedPath = dest;
    downloading = false;
    send({ kind: "ready", edition: targetEdition, version: chosen.version, latestTauri: lt, latestElectron: le });
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    downloading = false;
    const msg = error instanceof Error ? error.message : String(error);
    send({ kind: "error", edition: targetEdition, message: msg, latestTauri: lt, latestElectron: le });
    throw error;
  }
}

export function installUpdate(): void {
  if (!downloadedPath) {
    const fallback = preferredEdition === "tauri" ? pendingTauri?.htmlUrl : pendingElectron?.htmlUrl;
    if (fallback) {
      void shell.openExternal(fallback);
      return;
    }
    throw new Error(tr("Update installer not found", "Файл обновления не найден"));
  }
  const child = spawn(downloadedPath, [], { detached: true, stdio: "ignore" });
  child.unref();
  app.quit();
}
