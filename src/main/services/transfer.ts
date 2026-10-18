import { tr } from "../i18n";

export type BytesCallback = (received: number, total: number | null) => void;

export interface TransferProgress {
  key: string;
  fileName: string;
  received: number;
  total: number | null;
  phase?: string;
  doneFiles?: number;
  totalFiles?: number;
}

function parseTotal(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export async function readUrlBytes(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onBytes: BytesCallback,
  timeoutMs = 5 * 60 * 1000
): Promise<{ buffer: Buffer; total: number | null }> {
  const ctrl = new AbortController();
  const onOuterAbort = (): void => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let totalTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), 30000);
  };
  const cleanup = (): void => {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onOuterAbort);
  };
  totalTimer = setTimeout(() => ctrl.abort(), timeoutMs);
  armIdle();
  try {
    const response = await fetch(url, { signal: ctrl.signal, headers });
    if (!response.ok) {
      throw new Error(tr(`Download failed with HTTP ${response.status}: ${url}`, `Ошибка загрузки, HTTP ${response.status}: ${url}`));
    }
    const total = response.body ? parseTotal(response.headers) : null;
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      onBytes(buffer.length, total ?? buffer.length);
      return { buffer, total: total ?? buffer.length };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      armIdle();
      onBytes(received, total);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { buffer, total };
  } catch (error) {
    if (ctrl.signal.aborted && !signal?.aborted) {
      throw new Error(tr(`Download timed out: ${url}`, `Время загрузки истекло: ${url}`));
    }
    throw error;
  } finally {
    cleanup();
  }
}

export function createThrottledEmitter(send: (update: TransferProgress) => void): (
  key: string,
  fileName: string,
  received: number,
  total: number | null,
  extra?: Pick<TransferProgress, "phase" | "doneFiles" | "totalFiles">
) => void {
  const lastSent = new Map<string, number>();
  return (key, fileName, received, total, extra) => {
    const now = Date.now();
    const finished = total !== null && received >= total;
    const last = lastSent.get(key) ?? 0;
    if (!finished && now - last < 150) return;
    lastSent.set(key, now);
    send({ key, fileName, received, total, ...extra });
  };
}
