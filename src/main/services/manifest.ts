import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstalledMod } from "@shared/types";

const queues = new Map<string, Promise<void>>();

let counter = 0;

export function writeContentManifest(instanceDirectory: string, mods: InstalledMod[]): Promise<void> {
  const target = path.join(instanceDirectory, ".launcher", "content.json");
  const snapshot = JSON.stringify(mods, null, 2);
  const previous = queues.get(target) ?? Promise.resolve();
  const run = previous.then(async () => {
    await mkdir(path.dirname(target), { recursive: true });
    const tmpPath = `${target}.${process.pid}.${(counter += 1)}.tmp`;
    await writeFile(tmpPath, snapshot, "utf8");
    await rename(tmpPath, target);
  });
  const settled = run.catch(() => undefined);
  queues.set(target, settled);
  void settled.then(() => {
    if (queues.get(target) === settled) queues.delete(target);
  });
  return run;
}
