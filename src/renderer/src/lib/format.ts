export function formatDownloads(value: number | undefined, lang: "en" | "ru"): string {
  return new Intl.NumberFormat(lang === "ru" ? "ru-RU" : "en-US", { notation: "compact" }).format(value ?? 0);
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const dateFormatter = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" });

export const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export const formattedDates = new Map<string, string>();

export function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const cached = formattedDates.get(iso);
  if (cached !== undefined) return cached;
  const date = new Date(iso);
  const text = Number.isNaN(date.getTime()) ? "" : `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
  if (formattedDates.size > 5000) formattedDates.clear();
  formattedDates.set(iso, text);
  return text;
}

export function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatRelative(iso: string | undefined, lang: "en" | "ru"): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "";
  const ago = (n: number, en: string, one: string, few: string, many: string): string =>
    lang === "ru" ? `${n} ${ruPlural(n, one, few, many)} назад` : `${n} ${en}${n === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return lang === "ru" ? "только что" : "just now";
  if (minutes < 60) return ago(minutes, "minute", "минуту", "минуты", "минут");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, "hour", "час", "часа", "часов");
  const days = Math.floor(hours / 24);
  if (days < 30) return ago(days, "day", "день", "дня", "дней");
  const months = Math.floor(days / 30);
  if (months < 12) return ago(months, "month", "месяц", "месяца", "месяцев");
  const years = Math.floor(months / 12);
  return ago(years, "year", "год", "года", "лет");
}

export function pageList(current: number, total: number): Array<number | "gap"> {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push("gap");
    out.push(page);
  });
  return out;
}

export function withFallback<T>(options: T[], current: T): T[] {
  return options.includes(current) ? options : [current, ...options];
}

export function transferLabel(entry: { received: number; total: number | null } | undefined): string | null {
  if (!entry) return null;
  if (entry.total !== null && entry.total > 0) {
    return `${Math.min(99, Math.floor((entry.received / entry.total) * 100))}%`;
  }
  return formatBytes(entry.received);
}
