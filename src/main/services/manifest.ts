import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstalledMod } from "@shared/types";

const queues = new Map<string, Promise<void>>();

let counter = 0;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function writeContentManifest(instanceDirectory: string, mods: InstalledMod[]): Promise<void> {
  const target = path.join(instanceDirectory, ".launcher", "content.json");
  const snapshot = JSON.stringify(mods, null, 2);
  const previous = queues.get(target) ?? Promise.resolve();
  const run = previous.then(async () => {
    await mkdir(path.dirname(target), { recursive: true });
    const tmpPath = `${target}.${process.pid}.${(counter += 1)}.tmp`;
    try {
      await writeFile(tmpPath, snapshot, "utf8");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rename(tmpPath, target);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 4) {
            await delay(60 * (attempt + 1));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  const settled = run.catch(() => undefined);
  queues.set(target, settled);
  void settled.then(() => {
    if (queues.get(target) === settled) queues.delete(target);
  });
  return run;
}
