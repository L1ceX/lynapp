import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JavaInstallation, JavaRuntimeState } from "@shared/types";
import { getLauncherRoot, getWindowsJavaCandidates } from "../paths";

const execFileAsync = promisify(execFile);

interface JavaCandidate {
  javawPath: string;
  major: number;
  source: JavaRuntimeState["source"];
}

function parseMinecraftVersion(version: string): { minor: number; patch: number } {
  const match = version.match(/^1\.(\d+)(?:\.(\d+))?/);

  if (!match) {
    return { minor: 21, patch: 0 };
  }

  return {
    minor: Number(match[1]),
    patch: Number(match[2] ?? "0")
  };
}

export function getRequiredJavaMajor(gameVersion: string): number {
  const parsed = parseMinecraftVersion(gameVersion);

  if (parsed.minor > 20 || (parsed.minor === 20 && parsed.patch >= 5)) {
    return 21;
  }

  if (parsed.minor >= 18) {
    return 17;
  }

  if (parsed.minor === 17) {
    return 16;
  }

  return 8;
}

export const managedJavaMajors = [25, 21, 17, 8];

function getRuntimeRoot(): string {
  return path.join(getLauncherRoot(), "runtimes");
}

function getRuntimeInstallDir(major: number): string {
  return path.join(getRuntimeRoot(), `temurin-jre-${major}`);
}

function getCacheDir(): string {
  return path.join(getLauncherRoot(), "cache", "java");
}

function toJavaExe(javawPath: string): string {
  return path.join(path.dirname(javawPath), "java.exe");
}

function parseJavaMajor(output: string): number | null {
  const versionMatch = output.match(/version "(?<version>[^"]+)"/);
  const version = versionMatch?.groups?.version;

  if (!version) {
    return null;
  }

  if (version.startsWith("1.")) {
    const legacy = Number(version.split(".")[1]);
    return Number.isFinite(legacy) ? legacy : null;
  }

  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) ? major : null;
}

function getAdoptiumArch(): string {
  switch (os.arch()) {
    case "arm64":
      return "aarch64";
    case "x64":
    default:
      return "x64";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return existsSync(filePath);
}

async function readJavaMajor(javawPath: string): Promise<number | null> {
  const javaExe = toJavaExe(javawPath);
  const executable = (await pathExists(javaExe)) ? javaExe : javawPath;

  try {
    const result = await execFileAsync(executable, ["-version"], {
      windowsHide: true,
      timeout: 8000
    });
    return parseJavaMajor(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr) : "";
    return parseJavaMajor(output);
  }
}

async function findJavawUnder(root: string, maxDepth = 5): Promise<string | null> {
  if (maxDepth < 0 || !(await pathExists(root))) {
    return null;
  }

  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === "javaw.exe") {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const found = await findJavawUnder(path.join(root, entry.name), maxDepth - 1);

    if (found) {
      return found;
    }
  }

  return null;
}

async function listRuntimeJavawPaths(): Promise<string[]> {
  const root = getRuntimeRoot();

  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.includes(".tmp-")) {
      continue;
    }

    const javaw = await findJavawUnder(path.join(root, entry.name));

    if (javaw) {
      paths.push(javaw);
    }
  }

  return paths;
}

async function collectCandidatePaths(preferredPaths: Array<string | undefined>): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of [...preferredPaths, ...(await listRuntimeJavawPaths()), ...getWindowsJavaCandidates()]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    result.push(candidate);
  }

  return result;
}

async function resolveCandidate(javawPath: string, source: JavaRuntimeState["source"]): Promise<JavaCandidate | null> {
  if (!(await pathExists(javawPath))) {
    return null;
  }

  const major = await readJavaMajor(javawPath);

  if (!major) {
    return null;
  }

  return {
    javawPath,
    major,
    source
  };
}

function getSource(javawPath: string, preferredPaths: string[]): JavaRuntimeState["source"] {
  const normalized = javawPath.toLowerCase();

  if (preferredPaths.some((item) => item && item.toLowerCase() === normalized)) {
    return "configured";
  }

  if (normalized.startsWith(getRuntimeRoot().toLowerCase())) {
    return "downloaded";
  }

  return "system";
}

function getAdoptiumDownloadUrl(major: number): string {
  const arch = getAdoptiumArch();
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${arch}/jre/hotspot/normal/eclipse?project=jdk`;
}

function isCompatibleJavaMajor(actualMajor: number, requiredMajor: number): boolean {
  return actualMajor === requiredMajor || (requiredMajor === 16 && actualMajor === 17);
}

function getDownloadMajor(requiredMajor: number): number {
  return requiredMajor === 16 ? 17 : requiredMajor;
}

function getRuntimeMessage(major: number, requiredMajor: number, verb: "Using" | "Downloaded"): string {
  if (major === requiredMajor) {
    return `${verb} Java ${major}`;
  }

  return `${verb} Java ${major} for Minecraft Java ${requiredMajor} requirement`;
}

function getExecErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";

    if (stderr) {
      return stderr;
    }

    if (stdout) {
      return stdout;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

async function downloadRuntimeZip(major: number): Promise<string> {
  await mkdir(getCacheDir(), { recursive: true });

  const zipPath = path.join(getCacheDir(), `temurin-jre-${major}.zip`);

  if (await pathExists(zipPath)) {
    return zipPath;
  }

  const tempPath = `${zipPath}.tmp`;
  const response = await fetch(getAdoptiumDownloadUrl(major), {
    headers: {
      "user-agent": "lynapp/1.0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Java ${major} download failed with HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(tempPath, buffer);
  await rm(zipPath, { force: true });
  await rename(tempPath, zipPath);
  return zipPath;
}

async function expandZip(zipPath: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  try {
    await execFileAsync("tar.exe", ["-xf", zipPath, "-C", destination], {
      windowsHide: true,
      timeout: 120000
    });
  } catch (error) {
    throw new Error(`Java archive extraction failed: ${getExecErrorMessage(error)}`);
  }
}

async function readInstalledMarker(runtimeDir: string): Promise<string | null> {
  const markerPath = path.join(runtimeDir, ".lian-runtime.json");

  if (!(await pathExists(markerPath))) {
    return null;
  }

  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { javawPath?: string };
    return marker.javawPath ?? null;
  } catch {
    return null;
  }
}

async function writeInstalledMarker(runtimeDir: string, major: number, javawPath: string): Promise<void> {
  await writeFile(
    path.join(runtimeDir, ".lian-runtime.json"),
    JSON.stringify(
      {
        major,
        javawPath,
        installedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
}

export class JavaService {
  async listCandidatePaths(preferredPaths: Array<string | undefined> = []): Promise<string[]> {
    return collectCandidatePaths(preferredPaths);
  }

  async ensureRuntime(requiredMajor: number, preferredPaths: Array<string | undefined> = []): Promise<JavaRuntimeState> {
    const candidates = await collectCandidatePaths(preferredPaths);
    const preferred = preferredPaths.filter(Boolean) as string[];

    for (const candidatePath of candidates) {
      const candidate = await resolveCandidate(candidatePath, getSource(candidatePath, preferred));

    if (candidate && isCompatibleJavaMajor(candidate.major, requiredMajor)) {
      return {
        requiredMajor,
        major: candidate.major,
        path: candidate.javawPath,
        source: candidate.source,
        installedNow: false,
        message: getRuntimeMessage(candidate.major, requiredMajor, "Using")
      };
    }
  }

    const downloadMajor = getDownloadMajor(requiredMajor);
    const runtimeDir = getRuntimeInstallDir(downloadMajor);
    const markerJavaw = await readInstalledMarker(runtimeDir);

    if (markerJavaw) {
      const markerCandidate = await resolveCandidate(markerJavaw, "downloaded");

      if (markerCandidate && isCompatibleJavaMajor(markerCandidate.major, requiredMajor)) {
        return {
          requiredMajor,
          major: markerCandidate.major,
          path: markerCandidate.javawPath,
          source: "downloaded",
          installedNow: false,
          message: getRuntimeMessage(markerCandidate.major, requiredMajor, "Using")
        };
      }
    }

    const installed = await this.installFresh(downloadMajor);

    if (!isCompatibleJavaMajor(installed.major, requiredMajor)) {
      throw new Error(`Downloaded Java ${downloadMajor}, but archive contains Java ${installed.major}.`);
    }

    return {
      requiredMajor,
      major: installed.major,
      path: installed.javawPath,
      source: "downloaded",
      installedNow: true,
      message: getRuntimeMessage(installed.major, requiredMajor, "Downloaded")
    };
  }

  async installMajor(requiredMajor: number): Promise<string> {
    const downloadMajor = getDownloadMajor(requiredMajor);
    const installed = await this.installFresh(downloadMajor);

    if (!isCompatibleJavaMajor(installed.major, requiredMajor)) {
      throw new Error(`Downloaded Java ${downloadMajor}, but archive contains Java ${installed.major}.`);
    }

    return installed.javawPath;
  }

  async findCompatiblePath(major: number, extraPaths: Array<string | undefined> = []): Promise<string | null> {
    const candidates = await collectCandidatePaths(extraPaths);
    const preferred = extraPaths.filter(Boolean) as string[];

    for (const candidatePath of candidates) {
      const candidate = await resolveCandidate(candidatePath, getSource(candidatePath, preferred));

      if (candidate && isCompatibleJavaMajor(candidate.major, major)) {
        return candidate.javawPath;
      }
    }

    return null;
  }

  async describeInstallation(major: number, preferredPath?: string): Promise<JavaInstallation> {
    const candidates = await collectCandidatePaths([preferredPath]);
    const preferred = preferredPath ? [preferredPath] : [];

    for (const candidatePath of candidates) {
      const candidate = await resolveCandidate(candidatePath, getSource(candidatePath, preferred));

      if (candidate && isCompatibleJavaMajor(candidate.major, major)) {
        return {
          major,
          path: candidate.javawPath,
          valid: true,
          source: candidate.source,
          message:
            candidate.source === "downloaded"
              ? `Java ${candidate.major} managed by lynapp`
              : candidate.source === "configured"
                ? `Custom Java ${candidate.major}`
                : `System Java ${candidate.major}`
        };
      }
    }

    return {
      major,
      path: preferredPath ?? "",
      valid: false,
      source: "missing",
      message: `Java ${major} is not installed`
    };
  }

  async getInstallations(preferredPaths: Record<string, string> = {}): Promise<JavaInstallation[]> {
    const result: JavaInstallation[] = [];

    for (const major of managedJavaMajors) {
      result.push(await this.describeInstallation(major, preferredPaths[String(major)]));
    }

    return result;
  }

  async inspectPickedPath(pickedPath: string): Promise<{ javawPath: string; major: number | null }> {
    let javawPath = pickedPath;

    if (/java\.exe$/i.test(pickedPath) && !/javaw\.exe$/i.test(pickedPath)) {
      const sibling = path.join(path.dirname(pickedPath), "javaw.exe");

      if (await pathExists(sibling)) {
        javawPath = sibling;
      }
    }

    if (!(await pathExists(javawPath))) {
      throw new Error("Selected file was not found.");
    }

    return { javawPath, major: await readJavaMajor(javawPath) };
  }

  private async installFresh(downloadMajor: number): Promise<{ javawPath: string; major: number }> {
    const runtimeDir = getRuntimeInstallDir(downloadMajor);
    const zipPath = await downloadRuntimeZip(downloadMajor);
    const tempDir = `${runtimeDir}.tmp-${Date.now()}`;

    try {
      await expandZip(zipPath, tempDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }

    const javawPath = await findJavawUnder(tempDir);

    if (!javawPath) {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`Downloaded Java ${downloadMajor}, but javaw.exe was not found in the archive.`);
    }

    const major = await readJavaMajor(javawPath);

    if (!major) {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`Downloaded Java ${downloadMajor}, but its version could not be detected.`);
    }

    await rm(runtimeDir, { recursive: true, force: true });
    await rename(tempDir, runtimeDir);

    const finalJavawPath = path.join(runtimeDir, path.relative(tempDir, javawPath));
    await writeInstalledMarker(runtimeDir, major, finalJavawPath);
    return { javawPath: finalJavawPath, major };
  }
}
