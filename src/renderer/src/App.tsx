import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Box,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderCog,
  FolderOpen,
  Globe,
  HardDrive,
  Heart,
  House,
  Image,
  KeyRound,
  Layers3,
  Lock,
  Minus,
  PackageSearch,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shirt,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  User,
  UserRoundCog,
  Waypoints,
  X,
  XCircle
} from "lucide-react";
import appIcon from "./assets/icon.png";
import { FunctionAnimation, SkinViewer } from "skinview3d";
import { THEME_DEFAULTS, THEME_GROUPS, THEME_PRESETS, THEME_TOKENS, hexToRgb, resolveTheme, type ThemeTokenId } from "@shared/theme";
import type {
  BootstrapState,
  CapeInfo,
  JavaInstallation,
  LauncherInstance,
  LauncherSettings,
  LocalContentItem,
  LocalContentKind,
  ModLoader,
  ModrinthProjectType,
  ModSearchResult,
  ModSortIndex,
  SkinInfo,
  UpdateStatus
} from "@shared/types";

type AppSection = "home" | "instances" | "launcher" | "visuals" | "skins" | "accounts";
type InstanceTab = "general" | "versions" | "content" | "files" | "runtime" | "logs";

const loaders: ModLoader[] = ["vanilla", "fabric", "forge", "quilt", "neoforge"];
const defaultCreateForm = { name: "New Instance", gameVersion: "1.21.1", loader: "fabric" as ModLoader, loaderVersion: "" };
const contentTypes = [
  { id: "mod" as const, label: "Mods", labelRu: "Моды", icon: PackageSearch },
  { id: "resourcepack" as const, label: "Resource packs", labelRu: "Ресурспаки", icon: Image },
  { id: "shader" as const, label: "Shaders", labelRu: "Шейдеры", icon: Sparkles },
  { id: "datapack" as const, label: "Data packs", labelRu: "Датапаки", icon: Database },
  { id: "modpack" as const, label: "Modpacks", labelRu: "Модпаки", icon: Archive }
];

const sortLabelRu: Record<string, string> = {
  Relevance: "По релевантности",
  Downloads: "По числу загрузок",
  Follows: "По числу подписок",
  "Recently updated": "Недавно обновлённые",
  Newest: "Недавно добавленные"
};

const fileSortLabelRu: Record<string, string> = {
  "Name A–Z": "Имя А–Я",
  "Name Z–A": "Имя Я–А",
  "Largest first": "Сначала большие",
  "Smallest first": "Сначала маленькие",
  "Newest first": "Сначала новые",
  "Oldest first": "Сначала старые"
};

function getLauncherApi() {
  if (!window.launcher) throw new Error("Launcher preload failed to load. Restart the launcher.");
  return window.launcher;
}

function formatDownloads(value?: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value ?? 0);
}

function formatBytes(bytes: number): string {
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

function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatRelative(iso?: string): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function pageList(current: number, total: number): Array<number | "gap"> {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push("gap");
    out.push(page);
  });
  return out;
}

const sortOptions: Array<{ id: ModSortIndex; label: string }> = [
  { id: "relevance", label: "Relevance" },
  { id: "downloads", label: "Downloads" },
  { id: "follows", label: "Follows" },
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" }
];
const loaderFilterOptions = ["fabric", "forge", "quilt", "neoforge"];
const fileSortOptions = [
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "size-desc", label: "Largest first" },
  { id: "size-asc", label: "Smallest first" },
  { id: "date-desc", label: "Newest first" },
  { id: "date-asc", label: "Oldest first" }
];

function filterSortFiles(items: LocalContentItem[], query: string, sort: string): LocalContentItem[] {
  const q = query.trim().toLowerCase();
  const rows = q
    ? items.filter((item) => `${item.displayName} ${item.fileName}`.toLowerCase().includes(q))
    : [...items];
  switch (sort) {
    case "name-desc":
      rows.sort((a, b) => b.displayName.localeCompare(a.displayName));
      break;
    case "size-desc":
      rows.sort((a, b) => b.size - a.size);
      break;
    case "size-asc":
      rows.sort((a, b) => a.size - b.size);
      break;
    case "date-desc":
      rows.sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")));
      break;
    case "date-asc":
      rows.sort((a, b) => String(a.modified ?? "").localeCompare(String(b.modified ?? "")));
      break;
    default:
      rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
      break;
  }
  return rows;
}
const fileGroups: Array<{ id: LocalContentKind; label: string; labelRu: string }> = [
  { id: "mod", label: "Mods", labelRu: "Моды" },
  { id: "resourcepack", label: "Resource packs", labelRu: "Ресурспаки" },
  { id: "shader", label: "Shaders", labelRu: "Шейдеры" },
  { id: "datapack", label: "Data packs", labelRu: "Датапаки" }
];

function withFallback<T>(options: T[], current: T): T[] {
  return options.includes(current) ? options : [current, ...options];
}

function contentLabel(type?: ModrinthProjectType): string {
  return contentTypes.find((item) => item.id === (type ?? "mod"))?.label ?? "Content";
}

function MemorySlider({ value, onChange, onCommit }: { value: number; onChange: (value: number) => void; onCommit?: (value: number) => void }) {
  const safe = Math.min(32768, Math.max(512, Math.round(value / 256) * 256 || 2048));
  const [local, setLocal] = useState(safe);
  useEffect(() => {
    setLocal(safe);
  }, [safe]);
  const gb = (local / 1024).toFixed(local % 1024 === 0 ? 0 : 1);
  const commit = (next: number): void => {
    onChange(next);
    onCommit?.(next);
  };
  return (
    <div className="memory-slider">
      <input type="range" min={512} max={32768} step={256} value={local} onChange={(event) => setLocal(Number(event.target.value))} onPointerUp={() => commit(local)} onKeyUp={() => commit(local)} onBlur={() => { if (local !== safe) commit(local); }} aria-label="Allocated RAM" />
      <span className="muted">{local} MB · {gb} GB</span>
    </div>
  );
}

function transferLabel(entry: { received: number; total: number | null } | undefined): string | null {
  if (!entry) return null;
  if (entry.total !== null && entry.total > 0) {
    return `${Math.min(99, Math.floor((entry.received / entry.total) * 100))}%`;
  }
  return formatBytes(entry.received);
}

function isInstallable(result: ModSearchResult): boolean {
  return !result.id.includes("error") && !result.categories.includes("error");
}

function detectCrash(log: string): { title: string; hint: string } | null {
  const text = log.slice(-30000);
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  const crashEvidence = /(outofmemoryerror|java heap space|unsupportedclassversionerror|unsupported class file|unsatisfiedlinkerror|invalid_grant|mod resolution failed|incompatible mods found|formattedexception|duplicate mod|pixel format not accelerated|glfw error 6554|could not set pixel format|no space left|cannot access the file|mixin apply failed|critical injection failure|failed injection|missing or unsupported mandatory|which is missing|exception in thread|caused by:|a fatal error|crash report|process crashed|game crashed|mixintransformererror)/.test(lower);
  if (!crashEvidence) return null;
  if (lower.includes("outofmemoryerror") || lower.includes("java heap space")) {
    return { title: "Нехватка памяти", hint: "Закройте другие приложения или увеличьте объём памяти во вкладке RAM." };
  }
  if (lower.includes("unsupportedclassversionerror")) {
    return { title: "Неподходящая версия Java", hint: "Установите версию Java, требуемую инстанцией, в настройках лаунчера." };
  }
  if (lower.includes("unsatisfiedlinkerror")) {
    return { title: "Повреждены нативные библиотеки", hint: "Удалите версию игры и запустите снова, чтобы библиотеки скачались заново." };
  }
  const majorMatch = lower.match(/unsupported class file major version (\d+)/);
  if (majorMatch) {
    const javaByMajor: Record<string, string> = { "69": "25", "68": "24", "67": "23", "66": "22", "65": "21", "64": "20", "63": "19", "61": "17", "55": "11", "52": "8" };
    const java = javaByMajor[majorMatch[1]] ?? `? (class ${majorMatch[1]})`;
    return { title: `Загрузчик устарел для Java ${java}`, hint: "Обновите загрузчик до выпуска с поддержкой этой Java либо дождитесь его." };
  }
  if (lower.includes("modules minecraft and") && lower.includes("export package")) {
    return { title: "Конфликт клиента Forge", hint: "Переустановите версию игры или загрузчик." };
  }
  if (lower.includes("invalid_grant") || lower.includes("xsts") || (lower.includes("minecraft profile") && lower.includes("401"))) {
    return { title: "Сессия входа истекла", hint: "Войдите снова во вкладке аккаунтов." };
  }
  const known: Array<{ keys: string[]; title: string; hint: string }> = [
    { keys: ["duplicate mod"], title: "Дублирующийся мод", hint: "Удалите одну из двух копий из папки mods." },
    { keys: ["pixel format not accelerated"], title: "Не удалось инициализировать графику", hint: "Обновите драйверы видеокарты. Старое встроенное видео может не запускать новые версии." },
    { keys: ["glfw error 65542"], title: "Не удалось инициализировать графику", hint: "Обновите драйверы видеокарты. Игре не удалось запустить OpenGL." },
    { keys: ["could not set pixel format"], title: "Не удалось инициализировать графику", hint: "Обновите драйверы видеокарты. Игре не удалось запустить OpenGL." },
    { keys: ["no space left on device"], title: "Диск переполнен", hint: "Освободите место на диске и запустите снова." },
    { keys: ["the process cannot access the file"], title: "Файл заблокирован", hint: "Закройте другие лаунчеры, проверки антивируса и оставшиеся процессы игры." },
    { keys: ["sinytra connector is present"], title: "Конфликт Sinytra", hint: "Удалите Connector или конфликтующий Fabric-мод и повторите." },
    { keys: ["mixin apply failed"], title: "Ошибка миксина", hint: "Мод попытался изменить игру и не смог. Удалите недавно добавленные моды." },
    { keys: ["optifine", "sodium"], title: "OptiFine против Sodium", hint: "Используйте либо OptiFine, либо Sodium с Iris, но не вместе." }
  ];
  for (const rule of known) {
    if (rule.keys.every((key) => lower.includes(key))) {
      return { title: rule.title, hint: rule.hint };
    }
  }
  const missingDep = lower.match(/requires [^.\n]*?of ([a-z0-9_\-.+]+),? which is missing/);
  if (missingDep) {
    return { title: `Отсутствует ${missingDep[1]}`, hint: `Установите ${missingDep[1]} во вкладке контента.` };
  }
  const forgeDep = lower.includes("missing or unsupported mandatory dependencies")
    ? lower.match(/mod id: '([^']+)'/)
    : null;
  if (forgeDep) {
    return { title: `Отсутствует мод '${forgeDep[1]}'`, hint: `Установите '${forgeDep[1]}' во вкладке контента.` };
  }
  const mixinMod = lower.match(/failed injection.*?from mod (\S+)/);
  if (mixinMod) {
    return { title: `Миксин мода '${mixinMod[1]}' вызвал краш`, hint: `Удалите или обновите мод '${mixinMod[1]}' либо проверьте без Sinytra Connector.` };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-40);
  if (lower.includes("mod resolution failed") || lower.includes("incompatible mods found") || lower.includes("formattedexception")) {
    const installs = [...text.matchAll(/Install ([A-Za-z0-9_'.+ -]+?), (?:version ([\d.]+) or later|any version)/gi)].map((m) => ({ name: m[1].trim(), version: m[2] ?? "" }));
    const api = installs.find((i) => i.name.toLowerCase().includes("fabric-api")) ?? installs[0];
    if (api) {
      return { title: `Отсутствует ${api.name}`, hint: api.version ? `Установите ${api.name} версии ${api.version} или новее во вкладке контента.` : `Установите ${api.name} во вкладке контента.` };
    }
    const javaNeed = text.match(/requires version (\d+) or later of[^]*?java/i);
    const javaHave = text.match(/but only the wrong version is present:\s*(\d+)/i);
    if (javaNeed) {
      return { title: `Требуется Java ${javaNeed[1]}`, hint: javaHave ? `Сейчас используется Java ${javaHave[1]}. Установите Java ${javaNeed[1]} в настройках лаунчера.` : `Установите Java ${javaNeed[1]} в настройках лаунчера.` };
    }
    return { title: "Несовместимость модов", hint: "Удалите недавно добавленные моды либо приведите загрузчик и версию игры в соответствие." };
  }
  const benign = (l: string): boolean => l.includes("reference map") || l.includes("error loading class") || l.includes("force-disabling mixin") || l.includes("workaround") || l.includes("pdh counter") || l.includes("invalid query") || l.includes("disabling further attempts");
  for (const line of lines) {
    const l = line.toLowerCase();
    if (benign(l)) continue;
    if (l.includes("mod resolution") || l.includes("missing mods") || l.includes("incompatible mods") || l.includes("requires mod") || l.includes("mixin apply failed") || l.includes("failed to launch")) {
      return { title: "Несовместимость модов", hint: "Удалите недавно добавленные моды либо приведите загрузчик и версию игры в соответствие." };
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (benign(l)) continue;
    if (l.includes("exception in thread") || l.includes("caused by:") || l.includes("a fatal error") || l.includes("crash report") || l.includes("process crashed") || (l.includes("exit code") && !l.includes("exit code 0"))) {
      return { title: "Краш", hint: line.trim().slice(0, 180) };
    }
  }
  return null;
}

interface DropdownProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

function Dropdown({ value, options, onChange, disabled, ariaLabel }: DropdownProps) {  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [up, setUp] = useState(false);
  const closeTimer = useRef<number | null>(null);

  function closeDropdown(): void {
    if (!open || closing) return;
    setClosing(true);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimer.current = null;
    }, document.documentElement.classList.contains("no-anim") ? 0 : 195);
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeDropdown();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDropdown();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  function toggle(): void {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) {
      if (closing) {
        setClosing(false);
        return;
      }
      setClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setOpen(false);
        setClosing(false);
        closeTimer.current = null;
      }, document.documentElement.classList.contains("no-anim") ? 0 : 195);
      return;
    }
    setClosing(false);
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const need = Math.min(options.length * 36 + 14, 264) + 8;
      const below = window.innerHeight - rect.bottom;
      setUp(below < need && rect.top > need + 40);
    }
    setOpen(true);
  }

  return (
    <div className="dropdown" ref={rootRef}>
      <button type="button" ref={buttonRef} className={open ? "dropdown-button open" : "dropdown-button"} disabled={disabled} aria-label={ariaLabel} onClick={toggle}>
        <span>{value}</span><ChevronDown size={15} />
      </button>
      {open && !disabled ? <div className={closing ? (up ? "dropdown-popup up closing" : "dropdown-popup closing") : (up ? "dropdown-popup up" : "dropdown-popup")} role="listbox">{options.map((option) => <button type="button" key={option} role="option" aria-selected={option === value} className={option === value ? "dropdown-option active" : "dropdown-option"} onClick={() => { onChange(option); closeDropdown(); }}>{option}</button>)}</div> : null}
    </div>
  );
}

function ThemePreview({ id, t }: { id: ThemeTokenId; t: (en: string, ru: string) => string }) {
  switch (id) {
    case "background":
      return <div className="pv-window"><div className="pv-top" /><div className="pv-body"><div className="pv-side" /><div className="pv-main"><div className="pv-bar" /><div className="pv-bar short" /></div></div></div>;
    case "sidebar":
      return <div className="pv-sidebar"><span className="count-badge">2</span><button type="button" className="instance-button active"><span><strong>{t("New Instance", "Новая инстанция")}</strong><small>1.21.1 / fabric</small></span></button></div>;
    case "cards":
      return <div className="pv-cards"><div className="stat-card"><span className="stat-value">8</span><span className="stat-label">{t("Mods", "Моды")}</span></div><span className="pill">Modrinth<small>{t("source tag", "метка источника")}</small></span></div>;
    case "inputs":
      return <div className="pv-col"><input value="1.21.1" readOnly aria-label={t("Preview input", "Поле ввода")} /><button type="button" className="dropdown-button"><span>fabric</span></button></div>;
    case "borders":
      return <div className="pv-col"><div className="pv-bordered">{t("Row one", "Первая строка")}</div><div className="pv-bordered">{t("Row two", "Вторая строка")}</div></div>;
    case "buttons":
      return <div className="button-row"><button type="button">{t("Sample", "Пример")}</button><button type="button" className="content-type active">{t("Mods", "Моды")}</button></div>;
    case "accent":
      return <div className="surface-heading"><Waypoints size={19} /><div><h3>{t("Versions", "Версии")}</h3></div></div>;
    case "active":
      return <nav className="instance-tabs"><button type="button" className="tab-button">{t("General", "Основные")}</button><button type="button" className="tab-button active">{t("Versions", "Версии")}</button></nav>;
    case "primary":
      return <button type="button" className="primary-button launch-button">{t("Launch", "Запустить")}</button>;
    case "danger":
      return <div className="pv-col"><button type="button" className="danger-button">{t("Delete instance", "Удалить инстанцию")}</button><span className="muted">{t("Folder is removed too", "Папка также будет удалена")}</span></div>;
    case "glow":
      return <div className="pv-col"><button type="button">{t("Hover me", "Наведите курсор")}</button><span className="muted">{t("Glow follows the cursor", "Свечение следует за курсором")}</span></div>;
    case "text":
      return <div className="preview-text"><strong>{t("New Instance", "Новая инстанция")}</strong><span>1.21.1 / fabric</span></div>;
    default:
      return <div className="preview-text"><span>{t("Secondary text sample", "Пример вторичного текста")}</span><span>{t("Last activity", "Последняя активность")}</span></div>;
  }
}

function drawSkinPreview(canvas: HTMLCanvasElement, image: HTMLImageElement, slim: boolean): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const u = 5;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const arm = slim ? 3 : 4;
  const bodyX = 40;
  const rowY = 44;
  const legY = 104;
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number) => {
    ctx.drawImage(image, sx, sy, w, h, dx, dy, w * u, h * u);
  };
  part(8, 8, 8, 8, bodyX, 4);
  part(40, 8, 8, 8, bodyX, 4);
  part(44, 20, arm, 12, bodyX - arm * u, rowY);
  part(44, 52, arm, 12, bodyX - arm * u, rowY);
  part(36, 52, arm, 12, bodyX + 8 * u, rowY);
  part(36, 52, arm, 12, bodyX + 8 * u, rowY);
  part(20, 20, 8, 12, bodyX, rowY);
  part(20, 36, 8, 12, bodyX, rowY);
  part(4, 20, 4, 12, bodyX, legY);
  part(4, 52, 4, 12, bodyX, legY);
  part(20, 52, 4, 12, bodyX + 4 * u, legY);
  part(20, 52, 4, 12, bodyX + 4 * u, legY);
}

function SkinPreview({ dataUrl, slim }: { dataUrl: string; slim: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const image = document.createElement("img");
    image.onload = () => drawSkinPreview(canvas, image, slim);
    image.src = dataUrl;
  }, [dataUrl, slim]);

  return <canvas ref={ref} width={120} height={176} className="skin-canvas" />;
}

function CapeThumb({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const image = document.createElement("img");
    image.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 1, 1, 10, 16, 0, 0, canvas.width, canvas.height);
    };
    image.src = url;
  }, [url]);

  return <canvas ref={ref} width={60} height={96} className="cape-canvas" />;
}

function SkinViewer3D({ dataUrl, slim, capeUrl }: { dataUrl: string | null; slim: boolean; capeUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const loadSeq = useRef(0);
  const latestReq = useRef<{ dataUrl: string | null; slim: boolean; capeUrl: string | null }>({ dataUrl, slim, capeUrl });
  latestReq.current = { dataUrl, slim, capeUrl };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewer = new SkinViewer({ canvas, width: 280, height: 340, pixelRatio: 1.5 });
    viewer.autoRotate = false;
    viewer.controls.enablePan = false;
    viewerRef.current = viewer;
    try {
      const internal = viewer as unknown as {
        composer?: {
          renderTarget1?: { samples?: number };
          renderTarget2?: { samples?: number };
          setSize?(width: number, height: number): void;
        };
      };
      if (internal.composer?.renderTarget1) internal.composer.renderTarget1.samples = 4;
      if (internal.composer?.renderTarget2) internal.composer.renderTarget2.samples = 4;
      internal.composer?.setSize?.(280, 340);
    } catch {
    }
    viewer.controls.enableRotate = false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let spinW = 0;
    let capeX = 0.14;
    let capeVX = 0;
    let playerRef: any = null;
    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      lastT = performance.now();
      spinW = 0;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
      }
    };
    const rotateAround = (v: { x: number; y: number; z: number }, axis: { x: number; y: number; z: number }, ang: number): void => {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
      const cx = axis.y * v.z - axis.z * v.y;
      const cy = axis.z * v.x - axis.x * v.z;
      const cz = axis.x * v.y - axis.y * v.x;
      v.x = v.x * c + cx * s + axis.x * dot * (1 - c);
      v.y = v.y * c + cy * s + axis.y * dot * (1 - c);
      v.z = v.z * c + cz * s + axis.z * dot * (1 - c);
    };
    const pitchCamera = (dy: number): void => {
      try {
        const internal = viewer as unknown as {
          controls?: {
            object?: { position: { x: number; y: number; z: number } };
            target?: { x: number; y: number; z: number };
            update?: () => void;
          };
        };
        const cam = internal.controls?.object;
        const tgt = internal.controls?.target;
        if (!cam || !tgt || dy === 0) return;
        const off = { x: cam.position.x - tgt.x, y: cam.position.y - tgt.y, z: cam.position.z - tgt.z };
        const len = Math.hypot(off.x, off.y, off.z) || 1;
        const rx = -off.z / len;
        const rz = off.x / len;
        const rn = Math.hypot(rx, rz) || 1;
        rotateAround(off, { x: rx / rn, y: 0, z: rz / rn }, dy * 0.005);
        const cosP = off.y / len;
        if (cosP < -0.95 || cosP > 0.95) return;
        cam.position.x = tgt.x + off.x;
        cam.position.y = tgt.y + off.y;
        cam.position.z = tgt.z + off.z;
        internal.controls?.update?.();
      } catch {
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || !playerRef) return;
      const now = performance.now();
      const dt = Math.min(Math.max((now - lastT) / 1000, 0.001), 0.1);
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      lastT = now;
      const w = (dx * 0.0085) / dt;
      playerRef.rotation.y += dx * 0.0085;
      spinW = spinW * 0.65 + w * 0.35;
      pitchCamera(dy);
    };
    const onPointerUp = (): void => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    try {
      viewer.animation = new FunctionAnimation((player: any, progress: number, delta: number) => {
        try {
          const dt = Math.min(Math.max(delta, 0.001), 0.1);
          playerRef = player;
          if (!dragging && player) {
            spinW *= Math.exp(-2.2 * dt);
            if (Math.abs(spinW) < 0.001) spinW = 0;
            player.rotation.y += spinW * dt;
          }
          const stiff = 55;
          const damp = 7;
          const restX = 0.12;
          const flareTarget = Math.min(spinW * spinW * 0.02, 0.6);
          capeVX += (-stiff * (capeX - (restX + flareTarget)) - damp * capeVX) * dt;
          capeX += capeVX * dt;
          const t = progress * 1.3;
          const sway = Math.sin(t);
          const skin = player?.skin;
          const body = skin?.body;
          if (body) {
            body.rotation.x = 0;
            body.rotation.z = 0;
          }
          const head = skin?.head;
          if (head) {
            head.rotation.y = Math.sin(t * 0.7 + 0.6) * 0.09;
            head.rotation.x = Math.sin(t * 0.9) * 0.03;
          }
          for (const key of ["leftArm", "rightArm"]) {
            const arm = skin?.[key];
            if (arm) {
              const dir = key === "leftArm" ? 1 : -1;
              arm.rotation.z = 0.08 * Math.sign(arm.position.x || 1);
              arm.rotation.x = dir * (0.04 + sway * 0.06);
            }
          }
          for (const key of ["leftLeg", "rightLeg"]) {
            const leg = skin?.[key];
            if (leg) {
              const dir = key === "leftLeg" ? 1 : -1;
              leg.rotation.z = 0.02 * Math.sign(leg.position.x || 1);
              leg.rotation.x = dir * sway * 0.025;
            }
          }
          const cape = player?.cape;
          if (cape) {
            cape.rotation.x = capeX;
            cape.rotation.y = 0;
          }
        } catch {
        }
      });
    } catch {
    }
    viewer.draw();
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const seq = (loadSeq.current += 1);
    const apply = async (): Promise<void> => {
      try {
        if (dataUrl) {
          await viewer.loadSkin(dataUrl, { model: slim ? "slim" : "default" });
        } else {
          viewer.loadSkin(null);
        }
        if (seq !== loadSeq.current) {
          return;
        }
        if (capeUrl) {
          await viewer.loadCape(capeUrl);
        } else {
          viewer.resetCape();
        }
      } catch {
      }
      if (seq !== loadSeq.current) {
        const latest = latestReq.current;
        const v = viewerRef.current;
        if (v) {
          try {
            if (latest.dataUrl) {
              await v.loadSkin(latest.dataUrl, { model: latest.slim ? "slim" : "default" });
            } else {
              v.loadSkin(null);
            }
            if (latest.capeUrl) {
              await v.loadCape(latest.capeUrl);
            } else {
              v.resetCape();
            }
          } catch {
          }
        }
      }
    };
    void apply();
  }, [dataUrl, slim, capeUrl]);

  return <canvas ref={canvasRef} className="skin-stage-canvas" />;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const lang = bootstrap?.settings.language === "ru" ? "ru" : "en";
  function t(en: string, ru: string): string {
    return lang === "ru" ? ru : en;
  }
  async function setLanguage(next: "en" | "ru"): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ language: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save language", "Не удалось сохранить язык"));
    }
  }
  const [section, setSection] = useState<AppSection>("home");
  const [instanceTab, setInstanceTab] = useState<InstanceTab>("general");
  const [tabExiting, setTabExiting] = useState(false);
  const [sectionExiting, setSectionExiting] = useState(false);
  const [contentExiting, setContentExiting] = useState(false);
  const tabTimer = useRef<number | null>(null);
  const sectionTimer = useRef<number | null>(null);
  const contentTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (tabTimer.current !== null) window.clearTimeout(tabTimer.current);
    if (sectionTimer.current !== null) window.clearTimeout(sectionTimer.current);
    if (contentTimer.current !== null) window.clearTimeout(contentTimer.current);
  }, []);

  const [maximized, setMaximized] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    getLauncherApi().isMaximized().then(setMaximized).catch(() => undefined);
    return getLauncherApi().onMaximizedChange(setMaximized);
  }, []);

  useEffect(() => {
    return getLauncherApi().onUpdateStatus((status) => {
      if (status.kind === "error") {
        setUpdate(null);
        return;
      }
      setUpdate(status);
    });
  }, []);

  async function downloadUpdate(): Promise<void> {
    setUpdate((current) => ({ kind: "downloading", percent: 0, version: current?.version }));
    try {
      await getLauncherApi().downloadUpdate();
    } catch (error) {
      setUpdate(null);
      setStatus(error instanceof Error ? error.message : t("Update download failed", "Не удалось скачать обновление"));
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await getLauncherApi().installUpdate();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Update install failed", "Не удалось установить обновление"));
    }
  }

  function switchTab(next: InstanceTab): void {
    if (tabTimer.current !== null) {
      window.clearTimeout(tabTimer.current);
      tabTimer.current = null;
    }
    if (next === instanceTab) {
      setTabExiting(false);
      return;
    }
    setTabExiting(true);
    tabTimer.current = window.setTimeout(() => {
      setInstanceTab(next);
      setTabExiting(false);
      tabTimer.current = null;
    }, animsRef.current ? 225 : 0);
  }

  function switchSection(next: AppSection): void {
    if (sectionTimer.current !== null) {
      window.clearTimeout(sectionTimer.current);
      sectionTimer.current = null;
    }
    if (next === section) {
      setSectionExiting(false);
      return;
    }
    setSectionExiting(true);
    sectionTimer.current = window.setTimeout(() => {
      setSection(next);
      setSectionExiting(false);
      sectionTimer.current = null;
    }, animsRef.current ? 225 : 0);
  }

  function switchContentType(next: ModrinthProjectType): void {
    if (contentTimer.current !== null) {
      window.clearTimeout(contentTimer.current);
      contentTimer.current = null;
    }
    if (next === contentType) {
      setContentExiting(false);
      return;
    }
    setContentExiting(true);
    contentTimer.current = window.setTimeout(() => {
      setContentType(next);
      setModResults([]);
      setContentExiting(false);
      contentTimer.current = null;
    }, animsRef.current ? 225 : 0);
  }
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState(defaultCreateForm);
  const [settingsDraft, setSettingsDraft] = useState<LauncherSettings | null>(null);
  const [theme, setTheme] = useState<Record<string, string>>({ ...THEME_DEFAULTS });
  const [previewToken, setPreviewToken] = useState<ThemeTokenId>("accent");
  const [glowOn, setGlowOn] = useState(true);
  const [glowSize, setGlowSize] = useState(100);
  const [glowSpeed, setGlowSpeed] = useState(100);
  const [animsOn, setAnimsOn] = useState(true);
  const glowColor = useRef<[number, number, number]>([255, 255, 255]);
  const glowOnRef = useRef(true);
  const glowSizeRef = useRef(100);
  const glowSpeedRef = useRef(100);
  const animsRef = useRef(true);
  const themeSaveTimer = useRef<number | null>(null);
  const prefsSaveTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (themeSaveTimer.current !== null) window.clearTimeout(themeSaveTimer.current);
    if (prefsSaveTimer.current !== null) window.clearTimeout(prefsSaveTimer.current);
  }, []);

  useEffect(() => {
    if (bootstrap) {
      setTheme(resolveTheme(bootstrap.settings.theme));
      setGlowOn(bootstrap.settings.glowEnabled ?? true);
      setGlowSize(bootstrap.settings.glowSize ?? 100);
      setGlowSpeed(Math.min(bootstrap.settings.glowSpeed ?? 100, 150));
      setAnimsOn(bootstrap.settings.animationsEnabled ?? true);
    }
  }, [bootstrap]);

  useEffect(() => {
    const root = document.documentElement;
    THEME_TOKENS.forEach((token) => token.vars.forEach((name) => root.style.setProperty(name, theme[token.id] ?? token.default)));
    glowColor.current = hexToRgb(typeof theme.glow === "string" ? theme.glow : "#ffffff");
    glowOnRef.current = glowOn;
    glowSizeRef.current = glowSize;
    glowSpeedRef.current = glowSpeed;
    animsRef.current = animsOn;
    root.classList.toggle("no-anim", !animsOn);
  }, [theme, glowOn, glowSize, glowSpeed, animsOn ]);

  async function persistTheme(next: Record<string, string>): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ theme: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft((current) => current ? { ...current, theme: next } : current);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save theme", "Не удалось сохранить тему"));
    }
  }

  function scheduleThemeSave(next: Record<string, string>): void {
    if (themeSaveTimer.current !== null) window.clearTimeout(themeSaveTimer.current);
    themeSaveTimer.current = window.setTimeout(() => {
      themeSaveTimer.current = null;
      void persistTheme(next);
    }, 350);
  }

  function setToken(id: ThemeTokenId, value: string): void {
    const next = { ...theme, [id]: value };
    setTheme(next);
    scheduleThemeSave(next);
  }

  function applyPreset(id: string): void {
    const found = THEME_PRESETS.find((item) => item.id === id);
    if (!found) return;
    const next = { ...found.values };
    setTheme(next);
    scheduleThemeSave(next);
    setStatus(t(`Theme: ${found.label}`, `Тема: ${found.label}`));
  }

  function savePrefs(next: { glowEnabled: boolean; glowSize: number; glowSpeed: number; animationsEnabled: boolean }): void {
    if (prefsSaveTimer.current !== null) window.clearTimeout(prefsSaveTimer.current);
    const snapshot = { ...next };
    prefsSaveTimer.current = window.setTimeout(() => {
      prefsSaveTimer.current = null;
      void getLauncherApi().updateSettings(snapshot).then((settings) => {
        setBootstrap((current) => current ? { ...current, settings } : current);
        setSettingsDraft((current) => current ? { ...current, ...snapshot } : current);
      }).catch((error) => setStatus(error instanceof Error ? error.message : "Failed to save"));
    }, 350);
  }

  function setGlowEnabled(value: boolean): void {
    setGlowOn(value);
    savePrefs({ glowEnabled: value, glowSize, glowSpeed, animationsEnabled: animsOn });
  }

  function setGlowSizeValue(value: number): void {
    setGlowSize(value);
    savePrefs({ glowEnabled: glowOn, glowSize: value, glowSpeed, animationsEnabled: animsOn });
  }

  function setGlowSpeedValue(value: number): void {
    setGlowSpeed(value);
    savePrefs({ glowEnabled: glowOn, glowSize, glowSpeed: value, animationsEnabled: animsOn });
  }

  function setAnimsEnabled(value: boolean): void {
    setAnimsOn(value);
    savePrefs({ glowEnabled: glowOn, glowSize, glowSpeed, animationsEnabled: value });
  }
  const [contentType, setContentType] = useState<ModrinthProjectType>("mod");
  const [modQuery, setModQuery] = useState("");
  const [modResults, setModResults] = useState<ModSearchResult[]>([]);
  const [contentSort, setContentSort] = useState<ModSortIndex>("relevance");
  const [contentLimit, setContentLimit] = useState(20);
  const [contentPage, setContentPage] = useState(1);
  const [totalHits, setTotalHits] = useState(0);
  const [hideInstalled, setHideInstalled] = useState(false);
  const [versionUnlocked, setVersionUnlocked] = useState(false);
  const [versionOverride, setVersionOverride] = useState<string | null>(null);
  const [loaderUnlocked, setLoaderUnlocked] = useState(false);
  const [loaderOverride, setLoaderOverride] = useState<string | null>(null);
  const [categoryTags, setCategoryTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [localContent, setLocalContent] = useState<LocalContentItem[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileSort, setFileSort] = useState("name-asc");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [instanceLogs, setInstanceLogs] = useState<{ log: string; plan: string; hasLog: boolean; crash: { file: string; description: string } | null } | null>(null);
  const [logsFollow, setLogsFollow] = useState(true);
  const logPreRef = useRef<HTMLPreElement | null>(null);
  const contentAutoKey = useRef("");
  const [skins, setSkins] = useState<SkinInfo[] | null>(null);
  const [skinBusy, setSkinBusy] = useState(false);
  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(null);
  const [capes, setCapes] = useState<CapeInfo[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [windowDrag, setWindowDrag] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modpackTarget, setModpackTarget] = useState<{ resultId: string; title: string; filePath: string; info: { totalFiles: number; packName: string; packGameVersion: string; packLoader: string } } | null>(null);
  const [exportModal, setExportModal] = useState<{ entries: Array<{ name: string; isDir: boolean; size: number; modified: string | null }>; checked: Record<string, boolean> } | null>(null);
  const [mrpackProgress, setMrpackProgress] = useState<Record<string, { done: number; total: number }>>({});

  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmDelete(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  useEffect(() => {
    return getLauncherApi().onMrpackProgress((update) => {
      setMrpackProgress((current) => ({ ...current, [update.instanceId]: { done: update.done, total: update.total } }));
    });
  }, []);
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const activeAccount = bootstrap?.accounts.find((item) => item.id === bootstrap.activeAccountId) ?? bootstrap?.accounts[0] ?? null;
  const canEditSkins = activeAccount?.kind === "microsoft" && (activeAccount?.status ?? "signed-out") === "signed-in";
  const isElyAccount = activeAccount?.kind === "ely";
  const [elySkin, setElySkin] = useState<{ dataUrl: string; slim: boolean } | null | undefined>(undefined);
  const activeSkinId = canEditSkins ? (settingsDraft?.activeSkinId ?? bootstrap?.settings.activeSkinId ?? null) : null;

  async function refreshSkins(): Promise<void> {
    try {
      setSkins(await getLauncherApi().listSkins());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load skins");
    }
  }

  useEffect(() => {
    if (section === "skins") {
      setSelectedSkinId(null);
      if (!canEditSkins) {
        setSkins([]);
        setCapes([]);
      } else {
        void refreshSkins();
        setCapes(null);
        getLauncherApi().listCapes().then(setCapes).catch(() => setCapes([]));
      }
    } else {
      setDropActive(false);
    }
  }, [section, canEditSkins]);

  useEffect(() => {
    if (section !== "skins" || activeAccount?.kind !== "ely") {
      setElySkin(undefined);
      return;
    }
    let stale = false;
    setElySkin(undefined);
    getLauncherApi().elySkin().then((skin) => {
      if (!stale) setElySkin(skin);
    }).catch(() => {
      if (!stale) setElySkin(null);
    });
    return () => {
      stale = true;
    };
  }, [section, activeAccount?.id]);

  async function uploadSkin(file: File): Promise<void> {
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft to change skins", "Войдите через Microsoft, чтобы изменять скины"));
      return;
    }
    setSkinBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
      });
      setSkins(await getLauncherApi().addSkin({ name: file.name.replace(/\.png$/i, ""), dataUrl, slim: false }));
      setStatus(t(`Added skin ${file.name}`, `Добавлен скин ${file.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to add skin");
    } finally {
      setSkinBusy(false);
    }
  }

  async function activateSkin(id: string, name: string): Promise<void> {
    setSkinBusy(true);
    try {
      const result = await getLauncherApi().activateSkin(id);
      setBootstrap((current) => current ? { ...current, settings: { ...current.settings, activeSkinId: result.activeSkinId } } : current);
      setSettingsDraft((current) => current ? { ...current, activeSkinId: result.activeSkinId } : current);
      setStatus(result.uploaded ? t(`Skin uploaded to Mojang: ${name}`, `Скин загружен в Mojang: ${name}`) : t(`Selected ${name}. Others see it on servers with skin plugins.`, `Выбрано: ${name}. Другие игроки увидят его на серверах с плагинами скинов.`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to apply skin");
    } finally {
      setSkinBusy(false);
    }
  }

  async function removeSkin(id: string, name: string): Promise<void> {
    setSkinBusy(true);
    try {
      const result = await getLauncherApi().removeSkin(id);
      setSkins(result.skins);
      setBootstrap((current) => current ? { ...current, settings: { ...current.settings, activeSkinId: result.activeSkinId } } : current);
      setSettingsDraft((current) => current ? { ...current, activeSkinId: result.activeSkinId } : current);
      setStatus(t(`Deleted skin ${name}`, `Скин удалён: ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete skin");
    } finally {
      setSkinBusy(false);
    }
  }

  async function equipCape(capeId: string | null): Promise<void> {
    setSkinBusy(true);
    try {
      setCapes(await getLauncherApi().equipCape(capeId));
      setStatus(capeId ? t("Cape equipped", "Плащ надет") : t("Cape removed", "Плащ снят"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to change cape");
    } finally {
      setSkinBusy(false);
    }
  }

  async function importMrpackByPath(filePath: string): Promise<void> {
    if (!/\.mrpack$/i.test(filePath)) {
      setStatus(t("Only .mrpack modpack files can be dropped here", "Сюда можно перетаскивать только файлы .mrpack"));
      return;
    }
    setBusy(true);
    const short = filePath.split(/[\\/]/).pop() ?? filePath;
    setStatus(t(`Importing ${short}...`, `Импорт: ${short}...`));
    let startedId: string | null = null;
    try {
      const started = await getLauncherApi().importMrpackStart(filePath);
      startedId = started.instance.id;
      await refresh({ setReadyStatus: false });
      setSelectedId(started.instance.id);
      switchSection("instances");
      setMrpackProgress((current) => ({ ...current, [started.instance.id]: { done: 0, total: started.totalFiles } }));
      setInstanceStatus((current) => ({ ...current, [started.instance.id]: `Importing ${started.instance.name}... 0%` }));
      setStatus(t(`Importing ${started.instance.name}... 0%`, `Импорт: ${started.instance.name}... 0%`));
      try {
        await getLauncherApi().importMrpackFiles(started.instance.id);
        await refresh({ setReadyStatus: false });
        setInstanceStatus((current) => ({ ...current, [started.instance.id]: `Imported ${started.instance.name}` }));
        setStatus(t(`Imported ${started.instance.name}`, `Импортировано: ${started.instance.name}`));
      } finally {
        setMrpackProgress((current) => {
          const next = { ...current };
          delete next[started.instance.id];
          return next;
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Modpack import failed";
      if (startedId) {
        const sid: string = startedId;
        setInstanceStatus((current) => ({ ...current, [sid]: message }));
      }
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function hasFiles(event: DragEvent): boolean {
      return !!event.dataTransfer && Array.from(event.dataTransfer.types ?? []).includes("Files");
    }
    function onDragEnter(event: DragEvent): void {
      if (sectionRef.current !== "instances") return;
      if (!hasFiles(event)) return;
      event.preventDefault();
      setWindowDrag(true);
    }
    function onDragOver(event: DragEvent): void {
      if (sectionRef.current !== "instances" || !hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(event: DragEvent): void {
      const to = event.relatedTarget as Node | null;
      if (to && document.documentElement.contains(to)) return;
      setWindowDrag(false);
    }
    function onDrop(event: DragEvent): void {
      if (sectionRef.current !== "instances" || !hasFiles(event)) return;
      event.preventDefault();
      setWindowDrag(false);
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (!files.length) return;
      void (async () => {
        const api = getLauncherApi();
        const paths: string[] = [];
        for (const file of files) {
          const direct = (file as unknown as { path?: string }).path;
          if (direct) {
            paths.push(direct);
            continue;
          }
          try {
            const resolved = await api.getFilePath(file);
            if (resolved) paths.push(resolved);
          } catch {
          }
        }
        if (!paths.length) {
          setStatus(t("Could not read the dropped file", "Не удалось прочитать перетащенный файл"));
          return;
        }
        const mrpack = paths.find((item) => /\.mrpack$/i.test(item));
        if (!mrpack) {
          setStatus(t("Only .mrpack modpack files can be dropped here", "Сюда можно перетаскивать только файлы .mrpack"));
          return;
        }
        void importMrpackByPath(mrpack);
      })();
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  function dropSkin(event: React.DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft to change skins", "Войдите через Microsoft, чтобы изменять скины"));
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadSkin(file);
  }

  async function setSkinModel(id: string, slim: boolean): Promise<void> {
    setSkinBusy(true);
    try {
      setSkins(await getLauncherApi().updateSkin({ id, patch: { slim } }));
      if (id === activeSkinId) {
        const current = skins?.find((item) => item.id === id);
        await activateSkin(id, current?.name ?? "skin");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to update skin");
    } finally {
      setSkinBusy(false);
    }
  }
  const [offlineName, setOfflineName] = useState("");
  const [elyName, setElyName] = useState("");
  const [elyPassword, setElyPassword] = useState("");
  const [elyTotp, setElyTotp] = useState("");
  const [status, setStatus] = useState("Loading launcher state");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  const [transferPct, setTransferPct] = useState<Record<string, { received: number; total: number | null }>>({});

  useEffect(() => {
    return getLauncherApi().onDownloadProgress((update) => {
      if (update.key.startsWith("launch:")) {
        const id = update.key.slice(7);
        if (update.phase === "java") {
          const label = transferLabel({ received: update.received, total: update.total });
          setInstanceStatus((current) => ({ ...current, [id]: t(`Downloading Java ${label ?? "..."}`, `Загрузка Java ${label ?? "..."}`) }));
        } else if (update.phase === "loader") {
          setInstanceStatus((current) => ({ ...current, [id]: t("Installing loader...", "Установка загрузчика...") }));
        } else {
          const label = update.phase === "assets" ? t("Preparing assets", "Подготовка ассетов") : t("Preparing libraries", "Подготовка библиотек");
          setInstanceStatus((current) => ({ ...current, [id]: `${label} ${update.doneFiles ?? 0}/${update.totalFiles ?? 0}` }));
        }
        return;
      }
      setTransferPct((current) => ({ ...current, [update.key]: { received: update.received, total: update.total } }));
    });
  }, []);
  const [launchingIds, setLaunchingIds] = useState<string[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<Record<string, string>>({});

  function assertNotLaunching(): boolean {
    if (selected && launchingIds.includes(selected.id)) {
      setStatus(t(`Cancel the launch of ${selected.name} first`, `Сначала отмените запуск ${selected.name}`));
      return false;
    }
    return true;
  }
  const [javaInstalls, setJavaInstalls] = useState<JavaInstallation[] | null>(null);
  const [javaBusy, setJavaBusy] = useState<number | null>(null);
  const [gameVersions, setGameVersions] = useState<string[] | null>(null);
  const [loaderSupport, setLoaderSupport] = useState<Record<string, string[]> | null>(null);
  const [loaderVersions, setLoaderVersions] = useState<string[] | null>(null);

  const refreshRunning = useCallback(async () => {
    try {
      setRunningIds(await getLauncherApi().getRunningInstances());
    } catch {
    }
  }, []);

  useEffect(() => {
    void refreshRunning();
    const timer = window.setInterval(() => {
      void refreshRunning();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshRunning]);

  const refresh = useCallback(async (options?: { setReadyStatus?: boolean }) => {
    const next = await getLauncherApi().getBootstrap();
    setBootstrap(next);
    setSettingsDraft(next.settings);
    setSelectedId((current) => current ?? next.activeInstanceId ?? next.instances[0]?.id ?? null);
    if (options?.setReadyStatus !== false) setStatus("");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setStatus(error instanceof Error ? error.message : "Failed to load launcher"));
  }, [refresh]);

  const refreshVersions = useCallback(async () => {
    try {
      const versions = await getLauncherApi().getGameVersions();
      setGameVersions(versions);
      setCreateForm((form) => (versions.includes(form.gameVersion) ? form : { ...form, gameVersion: versions[0] ?? form.gameVersion }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load Minecraft versions");
    }
    try {
      setLoaderSupport(await getLauncherApi().getLoaderSupport());
    } catch {
      setLoaderSupport(null);
    }
  }, []);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions]);

  useEffect(() => {
    if (activeAccount?.status === "offline" && activeAccount?.profileName) setOfflineName(activeAccount.profileName);
  }, [activeAccount?.profileName, activeAccount?.status]);

  useEffect(() => {
    if (!activeAccount || activeAccount.kind !== "microsoft" || activeAccount.status !== "signed-in") return;
    const exp = activeAccount.expiresAt ? Date.parse(activeAccount.expiresAt) : NaN;
    if (!Number.isNaN(exp) && exp - Date.now() > 24 * 3600 * 1000) return;
    let stale = false;
    void getLauncherApi().refreshSession().then((state) => {
      if (stale) return;
      const refreshed = state.accounts.find((item) => item.id === state.activeAccountId);
      const refreshedExp = refreshed?.expiresAt ? Date.parse(refreshed.expiresAt) : NaN;
      if (!Number.isNaN(refreshedExp) && refreshedExp - Date.now() > 24 * 3600 * 1000) {
        void refresh({ setReadyStatus: false });
      }
    }).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [bootstrap?.activeAccountId]);

  const refreshJava = useCallback(async () => {
    try {
      setJavaInstalls(await getLauncherApi().getJavaInstallations());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to load Java installations", "Не удалось загрузить установленные версии Java"));
    }
  }, []);

  useEffect(() => {
    if (section === "launcher") void refreshJava();
  }, [section, refreshJava]);

  useEffect(() => {
    const graceTimers = new WeakMap<HTMLButtonElement, number>();
    const cycleStarts = new WeakMap<HTMLButtonElement, number>();

    function findButton(event: Event): HTMLButtonElement | null {
      const target = event.target as Element | null;
      return (target?.closest?.("button") as HTMLButtonElement | null) ?? null;
    }

    function onMouseOver(event: Event): void {
      const button = findButton(event);
      if (!button || button.disabled) return;
      if (button.classList.contains("dropdown-option") || button.classList.contains("page-button") || button.classList.contains("path-open") || button.classList.contains("rail-button") || button.classList.contains("titlebar-button")) return;
      const pending = graceTimers.get(button);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        graceTimers.delete(button);
        return;
      }
      if (button.classList.contains("sheen-live")) return;
      button.classList.add("sheen-live");
      cycleStarts.set(button, Date.now() + 1000);
    }

    function onMouseOut(event: Event): void {
      const button = findButton(event);
      if (!button || !button.classList.contains("sheen-live")) return;
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (related && button.contains(related)) return;
      const elapsed = (Date.now() - (cycleStarts.get(button) ?? 0)) % 4000;
      const sweepLeft = elapsed < 0 ? 0 : elapsed < 1600 ? 1600 - elapsed : 0;
      if (sweepLeft <= 0) {
        button.classList.remove("sheen-live");
        cycleStarts.delete(button);
        return;
      }
      const timer = window.setTimeout(() => {
        button.classList.remove("sheen-live");
        cycleStarts.delete(button);
        graceTimers.delete(button);
      }, sweepLeft);
      graceTimers.set(button, timer);
    }

    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
    };
  }, []);

  useEffect(() => {
    const glow = document.createElement("div");
    glow.className = "cursor-glow";
    document.body.appendChild(glow);
    let current: Element | null = null;
    let cx = 0;
    let cy = 0;
    let gx = -300;
    let gy = -300;
    let raf = 0;

    function place(): void {
      if (!glowOnRef.current || !current || !document.contains(current)) {
        if (current) {
          current = null;
          glow.classList.remove("on");
        }
        raf = requestAnimationFrame(place);
        return;
      }
      const rect = current.getBoundingClientRect();
      const follow = Math.min(1, 0.16 * (glowSpeedRef.current / 100));
      gx += (cx - gx) * follow;
      gy += (cy - gy) * follow;
      const radius = Math.max(rect.width, rect.height) * 0.75 * (glowSizeRef.current / 100);
      const [gr, gg, gb] = glowColor.current;
      glow.style.width = `${rect.width}px`;
      glow.style.height = `${rect.height}px`;
      glow.style.borderRadius = getComputedStyle(current).borderRadius;
      glow.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      glow.style.background = `radial-gradient(circle ${radius.toFixed(0)}px at ${(gx - rect.left).toFixed(1)}px ${(gy - rect.top).toFixed(1)}px, rgba(${gr}, ${gg}, ${gb}, .22), rgba(${gr}, ${gg}, ${gb}, .07) 45%, transparent 70%)`;
      raf = requestAnimationFrame(place);
    }

    function onMove(event: MouseEvent): void {
      cx = event.clientX;
      cy = event.clientY;
      const target = (event.target as Element | null)?.closest?.('button, input, select, a, [role="button"]') ?? null;
      const next = target && glowOnRef.current && !(target as HTMLButtonElement).disabled ? target : null;
      if (next !== current) {
        current = next;
        gx = cx;
        gy = cy;
        glow.classList.toggle("on", !!next);
      }
    }

    function onLeave(): void {
      current = null;
      glow.classList.remove("on");
    }

    raf = requestAnimationFrame(place);
    document.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      glow.remove();
    };
  }, []);

  async function javaAction(major: number, action: "install" | "detect" | "browse"): Promise<void> {
    setJavaBusy(major);
    setStatus(action === "install" ? t(`Downloading Java ${major}...`, `Загрузка Java ${major}...`) : t(`Java ${major}: working...`, `Java ${major}: выполняется операция...`));
    try {
      const api = getLauncherApi();
      const updated = action === "install" ? await api.installJava(major) : action === "detect" ? await api.detectJava(major) : await api.browseJava(major);
      if (updated) {
        setJavaInstalls((current) => current ? current.map((item) => item.major === major ? updated : item) : current);
        setStatus(updated.message);
      } else {
        setStatus(t("Browse cancelled", "Операция отменена"));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Java ${major} action failed`);
    } finally {
      setJavaBusy(null);
    }
  }

  const selected = useMemo(
    () => bootstrap?.instances.find((instance) => instance.id === selectedId) ?? null,
    [bootstrap?.instances, selectedId]
  );

  const installedProjectIds = useMemo(() => new Set((selected?.mods ?? []).map((mod) => mod.projectId)), [selected?.mods]);
  const visibleResults = hideInstalled ? modResults.filter((result) => !installedProjectIds.has(result.id)) : modResults;
  const totalPages = Math.max(1, Math.ceil(totalHits / contentLimit));
  const sortLabel = sortOptions.find((option) => option.id === contentSort)?.label ?? "Relevance";
  const isSelectedRunning = selected !== null && runningIds.includes(selected.id);
  const isLaunching = launchingIds.length > 0 && selected !== null && launchingIds.includes(selected.id);
  const headerStatus = selected !== null ? instanceStatus[selected.id] ?? "" : "";
  const isVanillaSelected = selected?.loader === "vanilla";
  const visibleContentTypes = isVanillaSelected ? contentTypes.filter((item) => item.id === "resourcepack" || item.id === "datapack") : contentTypes;
  useEffect(() => {
    if (isVanillaSelected && contentType !== "resourcepack" && contentType !== "datapack") {
      setContentType("resourcepack");
      setModResults([]);
      setTotalHits(0);
    }
  }, [isVanillaSelected]);

  function say(message: string): void {
    if (selected) {
      setInstanceStatus((current) => ({ ...current, [selected.id]: message }));
    }
  }
  const totalMods = useMemo(() => (bootstrap?.instances ?? []).reduce((sum, item) => sum + (item.mods?.length ?? 0), 0), [bootstrap?.instances]);
  const lastActivity = useMemo(() => {
    const stamps = (bootstrap?.instances ?? []).map((item) => item.updatedAt ?? "").filter(Boolean);
    if (!stamps.length) return "";
    return formatRelative(stamps.sort().reverse()[0]);
  }, [bootstrap?.instances]);

  function loadersForVersion(version: string): ModLoader[] {
    if (!loaderSupport) return loaders;
    return loaders.filter((loader) => loader === "vanilla" || loaderSupport[loader]?.includes(version));
  }

  function versionsForLoader(loader: ModLoader): string[] {
    if (!gameVersions) return [];
    if (loader === "vanilla" || !loaderSupport) return gameVersions;
    return gameVersions.filter((version) => loaderSupport[loader]?.includes(version));
  }

  const [createLoaders, setCreateLoaders] = useState<ModLoader[] | null>(null);
  const [selectedLoaders, setSelectedLoaders] = useState<ModLoader[] | null>(null);

  async function availableLoaders(version: string): Promise<ModLoader[]> {
    const base = loadersForVersion(version);
    const results = await Promise.all(
      base.map(async (loader) => {
        if (loader === "vanilla") return loader;
        try {
          const versions = await getLauncherApi().getLoaderVersions(loader, version);
          return versions.length ? loader : null;
        } catch {
          return loader;
        }
      })
    );
    return results.filter((loader): loader is ModLoader => loader !== null);
  }

  useEffect(() => {
    const version = createForm.gameVersion;
    let stale = false;
    setCreateLoaders(null);
    void availableLoaders(version).then((list) => {
      if (stale) return;
      setCreateLoaders(list);
      setCreateForm((form) => (form.gameVersion === version && !list.includes(form.loader) ? { ...form, loader: "vanilla" } : form));
    });
    return () => {
      stale = true;
    };
  }, [createForm.gameVersion]);

  useEffect(() => {
    if (!selected) return;
    const version = selected.gameVersion;
    const id = selected.id;
    let stale = false;
    setSelectedLoaders(null);
    void availableLoaders(version).then((list) => {
      if (stale) return;
      setSelectedLoaders(list);
      if (selected.loader && list.length > 0 && !list.includes(selected.loader)) {
        setStatus(t(`${selected.name}: ${selected.loader} has no releases for ${version} yet`, `${selected.name}: у загрузчика ${selected.loader} пока нет выпусков для версии ${version}`));
      }
    });
    return () => {
      stale = true;
    };
  }, [selected?.id, selected?.gameVersion]);

  async function createInstance(): Promise<void> {
    if (creating) return;
    setCreating(true);
    try {
      const instance = await getLauncherApi().createInstance(createForm);
      setBootstrap((current) => current ? { ...current, activeInstanceId: instance.id, instances: [instance, ...current.instances] } : current);
      setSelectedId(instance.id);
      say(t(`Created ${instance.name}`, `Создано: ${instance.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create instance");
    } finally {
      setCreating(false);
    }
  }

  async function updateSelected(patch: Partial<LauncherInstance>): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    try {
      const updated = await getLauncherApi().updateInstance({ id: selected.id, patch });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      say(t(`Saved ${updated.name}`, `Сохранено: ${updated.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save instance");
    }
  }
  async function exportSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    setBusy(true);
    try {
      const entries = await getLauncherApi().listExportEntries(selected.id);
      const defaults = new Set(["mods", "resourcepacks", "shaderpacks", "datapacks", "config", "options.txt", "servers.dat", "optionsof.txt"]);
      const checked: Record<string, boolean> = {};
      for (const entry of entries) {
        checked[entry.name] = defaults.has(entry.name);
      }
      setExportModal({ entries, checked });
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to export ${selected.name}`, `Не удалось экспортировать: ${selected.name}`));
    } finally {
      setBusy(false);
    }
  }

  async function confirmExport(): Promise<void> {
    if (!exportModal || !selected || busy) return;
    const include = exportModal.entries.filter((entry) => exportModal.checked[entry.name]).map((entry) => entry.name);
    setExportModal(null);
    setBusy(true);
    say(t(`Exporting ${selected.name}...`, `Экспорт: ${selected.name}...`));
    try {
      const filePath = await getLauncherApi().exportMrpack(selected.id, include);
      if (filePath) {
        say(t(`Exported ${selected.name}`, `Экспортировано: ${selected.name}`));
      } else {
        say(t("Export cancelled", "Экспорт отменён"));
      }
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to export ${selected.name}`, `Не удалось экспортировать: ${selected.name}`));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    setBusy(true);
    try {
      await getLauncherApi().removeInstance(selected.id);
      setSelectedId(null);
      await refresh();
      say(t(`Deleted ${selected.name} with all its files`, `Удалено: ${selected.name} со всеми файлами`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete instance");
    } finally {
      setBusy(false);
    }
  }

  async function openSelectedFolder(): Promise<void> {
    if (!selected) return;
    try {
      const error = await getLauncherApi().openInstanceFolder(selected.id);
      if (error) setStatus(`Could not open folder: ${error}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not open folder");
    }
  }

  async function refreshLocalContent(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().getLocalContent(selected.id));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to read instance files");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().toggleLocalContent({ instanceId: selected.id, fileName: item.fileName, kind: item.kind }));
      say(`${item.enabled ? t("Disabled", "Отключено") : t("Enabled", "Включено")} ${item.displayName}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to toggle file");
    } finally {
      setBusy(false);
    }
  }

  async function removeLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().removeLocalContent({ instanceId: selected.id, fileName: item.fileName, kind: item.kind }));
      say(t(`Deleted ${item.displayName}`, `Удалено: ${item.displayName}`));
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete file");
    } finally {
      setBusy(false);
    }
  }

  async function launchSelected(): Promise<void> {
    if (!selected || launchingIds.includes(selected.id)) return;
    setLaunchingIds((current) => [...current, selected.id]);
    setInstanceLogs(null);
    say(t(`Preparing ${selected.gameVersion}...`, `Подготовка: ${selected.gameVersion}...`));
    try {
      const result = await getLauncherApi().launchInstance(selected.id);
      say(result.message);
      await refresh({ setReadyStatus: false });
      await refreshRunning();
    } catch (error) {
      say(error instanceof Error ? error.message : "Failed to prepare Java runtime");
    } finally {
      setLaunchingIds((current) => current.filter((id) => id !== selected.id));
    }
  }

  async function cancelSelected(): Promise<void> {
    if (!selected || !isLaunching) return;
    say(t("Cancelling launch...", "Отмена запуска..."));
    try {
      await getLauncherApi().cancelLaunch(selected.id);
    } catch (error) {
      say(error instanceof Error ? error.message : "Failed to cancel launch");
    }
  }

  async function stopSelected(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await getLauncherApi().stopInstance(selected.id);
      say(result.message);
      await refreshRunning();
    } catch (error) {
      say(error instanceof Error ? error.message : "Failed to stop instance");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(): Promise<void> {
    if (!settingsDraft) return;
    const settings = await getLauncherApi().updateSettings({
      maxMemoryMb: settingsDraft.maxMemoryMb,
      extraJvmArgs: settingsDraft.extraJvmArgs
    });
    setBootstrap((current) => current ? { ...current, settings } : current);
    setSettingsDraft(settings);
    setStatus(t("Settings saved", "Настройки сохранены"));
  }

  useEffect(() => {
    setContentPage(1);
    setTotalHits(0);
    setModResults([]);
    setVersionUnlocked(false);
    setVersionOverride(null);
    setLoaderUnlocked(false);
    setLoaderOverride(null);
    setSelectedCategories([]);
    setHideInstalled(false);
    getLauncherApi().getCategoryTags(contentType).then(setCategoryTags).catch(() => setCategoryTags([]));
  }, [selectedId, contentType]);

  useEffect(() => {
    if (instanceTab !== "content" || !selectedId || busy) return;
    const key = `${selectedId}|${contentType}`;
    if (contentAutoKey.current === key || modResults.length > 0) return;
    contentAutoKey.current = key;
    void runContentSearch({ page: 1 });
  });

  useEffect(() => {
    if (instanceTab !== "files" || !selectedId) return;
    setLocalContent(null);
    void refreshLocalContent();
  }, [instanceTab, selectedId]);

  async function refreshInstanceLogs(silent: boolean): Promise<void> {
    if (!selectedId) return;
    const live = runningIds.includes(selectedId) || launchingIds.includes(selectedId);
    if (!live) {
      setInstanceLogs(null);
      return;
    }
    try {
      const logs = await getLauncherApi().getInstanceLogs(selectedId);
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog ? prev : logs));
    } catch (error) {
      if (!silent) say(error instanceof Error ? error.message : "Failed to read logs");
    }
  }

  useEffect(() => {
    setInstanceLogs(null);
  }, [instanceTab, selectedId]);

  const logsLive = selectedId !== null && instanceTab === "logs" && (runningIds.includes(selectedId) || launchingIds.includes(selectedId));
  const crashAssist = useMemo(() => {
    if (!instanceLogs || !instanceLogs.hasLog) return null;
    const found = detectCrash(instanceLogs.log);
    if (found && found.title !== "Crashed") return found;
    if (instanceLogs.crash) {
      return { title: found?.title ?? "Crashed", hint: `${instanceLogs.crash.description} (${instanceLogs.crash.file})` };
    }
    return found;
  }, [instanceLogs]);

  async function copyCrashAssist(): Promise<void> {
    if (!instanceLogs || !crashAssist) return;
    try {
      const crashFile = instanceLogs.crash ? `${instanceLogs.crash.file}: ${instanceLogs.crash.description}\n\n` : "";
      await navigator.clipboard.writeText(`${crashAssist.title}\n${crashAssist.hint}\n\n${crashFile}${instanceLogs.log.slice(-8000)}`);
      say(t("Crash info copied", "Данные о краше скопированы"));
    } catch {
      say(t("Failed to copy crash info", "Не удалось скопировать данные о краше"));
    }
  }

  useEffect(() => {
    if (!logsLive || !selectedId) return;
    let stale = false;
    const apply = (logs: { log: string; plan: string; hasLog: boolean; crash: { file: string; description: string } | null }): void => {
      if (stale) return;
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog && prev.crash?.file === logs.crash?.file ? prev : logs));
    };
    void getLauncherApi().getInstanceLogs(selectedId).then(apply).catch(() => {
      if (!stale) setInstanceLogs({ log: "", plan: "", hasLog: false, crash: null });
    });
    const timer = window.setInterval(() => {
      void getLauncherApi().getInstanceLogs(selectedId).then(apply).catch(() => undefined);
    }, 1500);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [logsLive, selectedId]);

  useEffect(() => {
    if (instanceTab !== "logs" || !logsFollow) return;
    const el = logPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [instanceTab, instanceLogs, logsFollow]);

  useEffect(() => {
    if (instanceTab !== "versions" || !selected || selected.loader === "vanilla") {
      setLoaderVersions(null);
      return;
    }
    let cancelled = false;
    setLoaderVersions(null);
    getLauncherApi().getLoaderVersions(selected.loader, selected.gameVersion).then((versions) => {
      if (cancelled) return;
      setLoaderVersions(versions);
      const current = selected.loaderVersion?.trim() ?? "";
      if (current && versions.length > 0 && !versions.includes(current)) {
        setStatus(t(`${selected.name}: loader version ${current} is not listed upstream, keeping it`, `${selected.name}: версия загрузчика ${current} не найдена в списке, оставлена текущая`));
      }
    }).catch(() => {
      if (!cancelled) setLoaderVersions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [instanceTab, selected?.id, selected?.gameVersion, selected?.loader]);

  interface ContentQuery {
    page: number;
    sort: ModSortIndex;
    limit: number;
    categories: string[];
    versions: string[];
    loaders: string[];
  }

  function currentContentQuery(overrides: Partial<ContentQuery> = {}): ContentQuery {
    return {
      page: overrides.page ?? contentPage,
      sort: overrides.sort ?? contentSort,
      limit: overrides.limit ?? contentLimit,
      categories: overrides.categories ?? selectedCategories,
      versions: overrides.versions ?? (versionUnlocked && versionOverride ? [versionOverride] : []),
      loaders: overrides.loaders ?? ((contentType === "mod" || contentType === "modpack") && loaderUnlocked && loaderOverride ? [loaderOverride] : [])
    };
  }

  async function runContentSearch(overrides: Partial<ContentQuery> = {}): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    const query = currentContentQuery(overrides);
    setBusy(true);
    try {
      const response = await getLauncherApi().searchMods({
        query: modQuery,
        instanceId: selected.id,
        projectType: contentType,
        sort: query.sort,
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
        categories: query.categories,
        versions: query.versions,
        loaders: query.loaders
      });
      setModResults(response.results);
      setTotalHits(response.totalHits);
      setContentPage(query.page);
      setContentSort(query.sort);
      setContentLimit(query.limit);
      setSelectedCategories(query.categories);
      say(t(`Found ${response.totalHits} ${contentLabel(contentType).toLowerCase()} on Modrinth`, `Найдено: ${response.totalHits} — ${(contentTypes.find((c) => c.id === contentType)?.labelRu ?? "").toLowerCase()} на Modrinth`));
    } catch (error) {
      say(error instanceof Error ? error.message : "Modrinth search failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleCategory(tag: string): void {
    const next = selectedCategories.includes(tag) ? selectedCategories.filter((item) => item !== tag) : [...selectedCategories, tag];
    void runContentSearch({ page: 1, categories: next });
  }

  async function installContent(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    if (!assertNotLaunching()) return;
    if (downloadingIds.includes(result.id)) return;
    setDownloadingIds((current) => [...current, result.id]);
    if (result.projectType === "modpack") {
      try {
        say(t(`Downloading ${result.title}...`, `Загрузка: ${result.title}...`));
        const filePath = await getLauncherApi().downloadModpack({
          instanceId: selected.id,
          projectId: result.id,
          name: result.title
        });
        await importMrpackByPath(filePath);
      } catch (error) {
        say(error instanceof Error ? error.message : `Failed to download ${result.title}`);
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== result.id));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${result.id}`];
          return next;
        });
      }
      return;
    }
    try {
      const updated = await getLauncherApi().installMod({
        instanceId: selected.id,
        provider: "modrinth",
        projectId: result.id,
        name: result.title,
        slug: result.slug,
        iconUrl: result.iconUrl,
        projectType: result.projectType
      });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      say(t(`Installed ${result.title}`, `Установлено: ${result.title}`));
    } catch (error) {
      say(error instanceof Error ? error.message : `Failed to download ${result.title}`);
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== result.id));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`mod:${result.id}`];
        return next;
      });
    }
  }

  async function installIntoThis(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    if (!assertNotLaunching()) return;
    if (downloadingIds.includes(result.id)) return;
    setDownloadingIds((current) => [...current, result.id]);
    try {
      say(t(`Downloading ${result.title}...`, `Загрузка: ${result.title}...`));
      const filePath = await getLauncherApi().downloadModpack({
        instanceId: selected.id,
        projectId: result.id,
        name: result.title
      });
      const info = await getLauncherApi().importMrpackStartToInstance(filePath, selected.id);
      if (info.packGameVersion !== selected.gameVersion || info.packLoader !== selected.loader) {
        setModpackTarget({ resultId: result.id, title: result.title, filePath, info });
        say(t(`${info.packName}: ${info.packGameVersion} / ${info.packLoader} vs instance ${selected.gameVersion} / ${selected.loader}`, `${info.packName}: ${info.packGameVersion} / ${info.packLoader}, в инстанции ${selected.gameVersion} / ${selected.loader}`));
        return;
      }
      try {
        await finishModpackToInstance(selected.id, selected.name);
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== result.id));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${result.id}`];
          return next;
        });
      }
    } catch (error) {
      say(error instanceof Error ? error.message : `Failed to download ${result.title}`);
      setDownloadingIds((current) => current.filter((id) => id !== result.id));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${result.id}`];
        return next;
      });
    }
  }

  async function finishModpackToInstance(instanceId: string, instanceName: string): Promise<void> {
    setBusy(true);
    try {
      await refresh({ setReadyStatus: false });
      setMrpackProgress((current) => ({ ...current, [instanceId]: { done: 0, total: 0 } }));
      setInstanceStatus((current) => ({ ...current, [instanceId]: t(`Importing into ${instanceName}...`, `Импорт в ${instanceName}...`) }));
      await getLauncherApi().importMrpackFiles(instanceId);
      await refresh({ setReadyStatus: false });
      setInstanceStatus((current) => ({ ...current, [instanceId]: `Imported into ${instanceName}` }));
      setStatus(t(`Imported into ${instanceName}`, `Импортировано в ${instanceName}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Modpack import failed";
      setInstanceStatus((current) => ({ ...current, [instanceId]: message }));
      setStatus(message);
    } finally {
      setMrpackProgress((current) => {
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
      setBusy(false);
    }
  }

  async function confirmModpackTarget(): Promise<void> {
    if (!modpackTarget || !selected) return;
    const target = modpackTarget;
    setModpackTarget(null);
    try {
      await finishModpackToInstance(selected.id, selected.name);
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== target.resultId));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${target.resultId}`];
        return next;
      });
    }
  }

  async function cancelModpackTarget(): Promise<void> {
    if (!modpackTarget || !selected) return;
    const target = modpackTarget;
    setModpackTarget(null);
    try {
      await getLauncherApi().importMrpackCancel(selected.id);
    } catch {
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== target.resultId));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${target.resultId}`];
        return next;
      });
      say(t("Modpack install cancelled", "Установка модпака отменена"));
    }
  }

  async function beginLogin(): Promise<void> {
    setBusy(true);
    setStatus(t("Starting Microsoft login...", "Выполняется вход через Microsoft..."));
    try {
      const result = await getLauncherApi().beginMicrosoftLogin();
      setStatus(result.message);
      await refresh({ setReadyStatus: false });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Microsoft login failed");
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount(id: string): Promise<void> {
    if (busy || id === activeAccount?.id) return;
    setBusy(true);
    try {
      const name = bootstrap?.accounts.find((item) => item.id === id)?.profileName ?? "account";
      await getLauncherApi().setActiveAccount(id);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Playing as ${name}`, `Вы играете как ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to switch account");
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: string, name: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await getLauncherApi().removeAccount(id);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Removed ${name}`, `Удалено: ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to remove account");
    } finally {
      setBusy(false);
    }
  }

  async function useOfflineProfile(): Promise<void> {
    setBusy(true);
    try {
      await getLauncherApi().useOfflineProfile(offlineName);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Offline profile: ${offlineName}`, `Офлайн-профиль: ${offlineName}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Offline profile failed", "Не удалось создать офлайн-профиль"));
    } finally {
      setBusy(false);
    }
  }

  async function elyLogin(): Promise<void> {
    setBusy(true);
    setStatus(t("Signing in with Ely.by...", "Выполняется вход через Ely.by..."));
    try {
      await getLauncherApi().elyLogin(elyName, elyPassword, elyTotp || undefined);
      setElyPassword("");
      setElyTotp("");
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Ely.by as ${elyName}`, `Ely.by: ${elyName}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ely.by login failed");
    } finally {
      setBusy(false);
    }
  }

  if (!bootstrap || !settingsDraft) {
    return <main className="loading-screen"><RefreshCw className="spin" size={24} /><span>{status}</span></main>;
  }

  const instanceTabs = [
    { id: "general" as const, label: t("General", "Основные"), icon: SlidersHorizontal },
    { id: "versions" as const, label: t("Versions", "Версии"), icon: Waypoints },
    { id: "content" as const, label: t("Content", "Контент"), icon: PackageSearch },
    { id: "files" as const, label: t("Files", "Файлы"), icon: Folder },
    { id: "runtime" as const, label: "RAM", icon: Cpu },
    { id: "logs" as const, label: t("Logs", "Журнал"), icon: ScrollText }
  ];

  return (
      <div className="app-shell">
      {windowDrag ? <div className="drop-overlay"><div className="drop-overlay-card"><Archive size={28} /><strong>{t("Drop .mrpack to create an instance", "Перетащите файл .mrpack, чтобы создать инстанцию")}</strong><span>{t("Release to import the modpack", "Отпустите, чтобы импортировать модпак")}</span></div></div> : null}
      <header className="titlebar" onDoubleClick={() => void getLauncherApi().toggleMaximize()}>
        <div className="titlebar-brand"><img src={appIcon} alt="" /><span>lynapp</span></div>
        <div className="titlebar-controls" onDoubleClick={(event) => event.stopPropagation()}>
          {update?.kind === "available" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void downloadUpdate()} title={t(`Download lynapp ${update.version ?? ""}`.trim(), `Скачать lynapp ${update.version ?? ""}`.trim())}><Download size={14} /> {t("Update", "Обновление")}{update.version ? ` ${update.version}` : ""}</button> : null}
          {update?.kind === "downloading" ? <button type="button" className="titlebar-button titlebar-update" disabled title={t("Downloading update", "Загрузка обновления")}><RefreshCw size={14} className="spin" /> {update.percent ?? 0}%</button> : null}
          {update?.kind === "ready" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void installUpdate()} title={t("Restart to install the update", "Перезапустите, чтобы установить обновление")}><Check size={14} /> {t("Restart", "Перезапустить")}</button> : null}
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().minimizeWindow()} aria-label={t("Minimize", "Свернуть")} title={t("Minimize", "Свернуть")}><Minus size={16} /></button>
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().toggleMaximize()} aria-label={maximized ? t("Restore", "Восстановить") : t("Maximize", "Развернуть")} title={maximized ? t("Restore", "Восстановить") : t("Maximize", "Развернуть")}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
          <button type="button" className="titlebar-button titlebar-close" onClick={() => void getLauncherApi().closeWindow()} aria-label={t("Close", "Закрыть")} title={t("Close", "Закрыть")}><X size={16} /></button>
        </div>
      </header>
      <div className="app-body">
      <aside className="icon-rail" aria-label={t("Launcher navigation", "Навигация")}>
        <nav className="rail-nav">
          <button className={section === "home" ? "rail-button active" : "rail-button"} onClick={() => switchSection("home")} aria-label={t("Home", "Главная")} title={t("Home", "Главная")}><House size={19} /></button>
          <button className={section === "instances" ? "rail-button active" : "rail-button"} onClick={() => switchSection("instances")} aria-label={t("Instances", "Инстанции")} title={t("Instances", "Инстанции")}><Layers3 size={19} /></button>
          <button className={section === "launcher" ? "rail-button active" : "rail-button"} onClick={() => switchSection("launcher")} aria-label={t("Launcher settings", "Настройки лаунчера")} title={t("Launcher settings", "Настройки лаунчера")}><Settings size={19} /></button>
          <button className={section === "visuals" ? "rail-button active" : "rail-button"} onClick={() => switchSection("visuals")} aria-label={t("Visuals", "Оформление")} title={t("Visuals", "Оформление")}><Palette size={19} /></button>
          <button className={section === "skins" ? "rail-button active" : "rail-button"} onClick={() => switchSection("skins")} aria-label={t("Skins", "Скины")} title={t("Skins", "Скины")}><Shirt size={19} /></button>
          <button className={section === "accounts" ? "rail-button active" : "rail-button"} onClick={() => switchSection("accounts")} aria-label={t("Account settings", "Аккаунты")} title={t("Account settings", "Аккаунты")}><UserRoundCog size={19} /></button>
        </nav>
        <button className="rail-button rail-refresh" onClick={() => { void refresh(); void refreshVersions(); }} aria-label={t("Refresh", "Обновить")} title={t("Refresh", "Обновить")}><RefreshCw size={17} /></button>
      </aside>

      {section === "home" && (
        <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
          <header className="workspace-header"><div><span className="eyebrow">{t("Home", "Главная")}</span><h2>{t("Welcome back", "С возвращением")}</h2><span className="status-line">{selected !== null ? instanceStatus[selected.id] ?? status : status}</span></div></header>
          <section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Box size={19} /><div><h3>{selected?.name ?? t("No instance yet", "Инстанций пока нет")}</h3><span>{selected ? `${selected.gameVersion} / ${selected.loader}${selected.loaderVersion ? ` ${selected.loaderVersion}` : ""}` : t("Create an instance to start playing.", "Создайте инстанцию, чтобы начать играть")}</span></div></div><div className="button-row">{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}{selected ? <button onClick={() => switchSection("instances")}><SlidersHorizontal size={16} /> {t("Manage instance", "Настроить инстанцию")}</button> : <button className="primary-button" onClick={() => switchSection("instances")}><Plus size={16} /> {t("New instance", "Новая инстанция")}</button>}</div></div></section>
          <div className="stat-grid anim-stagger"><div className="stat-card"><span className="stat-value">{bootstrap.instances.length}</span><span className="stat-label">{t("Instances", "Инстанции")}</span></div><div className="stat-card"><span className="stat-value">{totalMods}</span><span className="stat-label">{t("Mods installed", "Установлено модов")}</span></div><div className="stat-card"><span className="stat-value">{runningIds.length}</span><span className="stat-label">{t("Running now", "Запущено сейчас")}</span></div><div className="stat-card"><span className="stat-value">{lastActivity || "—"}</span><span className="stat-label">{t("Last activity", "Последняя активность")}</span></div></div>
        </main>
      )}

      {section === "instances" && (
        <main className={sectionExiting ? "instances-workspace section-exiting" : "instances-workspace"}>
          <aside className="instance-sidebar">
            <div className="sidebar-heading"><div><span className="eyebrow">{t("Library", "Библиотека")}</span><h1>{t("Instances", "Инстанции")}</h1></div><span className="count-badge">{bootstrap.instances.length}</span></div>
            <div className="instance-list">
              {bootstrap.instances.map((instance) => { const progress = mrpackProgress[instance.id]; const launching = launchingIds.includes(instance.id); const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0; return <button key={instance.id} className={instance.id === selected?.id ? "instance-button active" : "instance-button"} onClick={() => setSelectedId(instance.id)} disabled={busy || !!progress}>{progress ? <span className="instance-progress"><span style={{ width: `${pct}%` }} /></span> : null}<Box size={18} /><span><strong>{instance.name}</strong><small>{progress ? `Importing... ${pct}%` : launching ? t("Launching...", "Запуск...") : `${instance.gameVersion} / ${instance.loader}`}</small></span>{progress || launching ? null : <ChevronRight size={16} />}</button>; })}
            </div>
            <form className="new-instance-form anim-stagger" onSubmit={(event) => { event.preventDefault(); void createInstance(); }}>
              <div className="form-caption"><Plus size={15} /> {t("New instance", "Новая инстанция")}</div>
              <input value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} placeholder={t("Instance name", "Название инстанции")} />
              <div className="two-col">{gameVersions ? <Dropdown value={createForm.gameVersion} options={withFallback(versionsForLoader(createForm.loader), createForm.gameVersion)} ariaLabel={t("Minecraft version", "Версия Minecraft")} onChange={(version) => { const compatible = loadersForVersion(version); setCreateForm((form) => ({ ...createForm, gameVersion: version, loader: compatible.includes(form.loader) ? form.loader : "vanilla" })); }} /> : <input value={createForm.gameVersion} onChange={(event) => setCreateForm({ ...createForm, gameVersion: event.target.value })} placeholder="1.21.1" />}<Dropdown value={createForm.loader} options={withFallback(createLoaders ?? loadersForVersion(createForm.gameVersion), createForm.loader)} ariaLabel={t("Loader", "Загрузчик")} onChange={(loader) => { const next = loader as ModLoader; const versions = versionsForLoader(next); setCreateForm((form) => ({ ...form, loader: next, gameVersion: versions.includes(form.gameVersion) ? form.gameVersion : versions[0] ?? form.gameVersion })); }} /></div>
              <button className="primary-button" disabled={creating}><Plus size={16} /> {t("Create", "Создать")}</button><span className="muted">{t("or drop a .mrpack anywhere", "или перетащите файл .mrpack в любое место")}</span>
            </form>
          </aside>

          <section className="instance-workspace">
            <header className="workspace-header"><div><span className="eyebrow">{headerStatus.trim() ? (selected?.name ?? t("No instance selected", "Инстанция не выбрана")) : t("Instance", "Инстанция")}</span>{headerStatus.trim() ? <h2 key="status-promoted" className="status-promoted">{headerStatus}</h2> : <h2 key="instance-name">{selected?.name ?? t("No instance selected", "Инстанция не выбрана")}</h2>}{headerStatus.trim() ? null : <span className="status-line">{headerStatus}</span>}</div>{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}</header>
            {selected ? <>
              <nav className="instance-tabs" aria-label={t("Instance settings", "Настройки инстанции")}>{instanceTabs.map(({ id, label, icon: Icon }) => <button key={id} className={instanceTab === id ? "tab-button active" : "tab-button"} onClick={() => switchTab(id)}><Icon size={16} />{label}</button>)}</nav>
              <section className={tabExiting ? "settings-surface tab-exiting" : "settings-surface"} key={instanceTab}>
                {instanceTab === "general" && <div className="settings-content"><div className="surface-heading"><FolderCog size={19} /><div><h3>{t("General", "Основные")}</h3><span>{t("Identity and location for this installation.", "Название и расположение этой инстанции.")}</span></div></div><label>{t("Instance name", "Название инстанции")}<input value={selected.name} onChange={(event) => void updateSelected({ name: event.target.value })} /></label><div className="readonly-path"><HardDrive size={16} /><span>{selected.directory}</span><button type="button" className="path-open" onClick={() => void openSelectedFolder()} title={t("Open instance folder", "Открыть папку инстанции")}><FolderOpen size={15} /></button></div><button onClick={() => void exportSelected()} disabled={busy || isSelectedRunning} title={t("Export instance as .mrpack", "Экспортировать инстанцию в .mrpack")}><Archive size={16} /> {t("Export .mrpack", "Экспорт .mrpack")}</button><button className="danger-button" onClick={() => setConfirmDelete(true)} disabled={busy || isSelectedRunning} title={isSelectedRunning ? t("Stop the instance first", "Сначала остановите инстанцию") : t("Delete the instance and its folder", "Удалить инстанцию с папкой")}><Trash2 size={16} /> {t("Delete instance", "Удалить инстанцию")}</button></div>}
                {instanceTab === "versions" && <div className="settings-content anim-stagger"><div className="surface-heading"><Waypoints size={19} /><div><h3>{t("Versions", "Версии")}</h3><span>{t("Minecraft version and loader for this instance.", "Версия Minecraft и загрузчик.")}</span></div></div><div className="two-col"><label>{t("Minecraft version", "Версия Minecraft")}{gameVersions ? <Dropdown value={selected.gameVersion} options={withFallback(versionsForLoader(selected.loader), selected.gameVersion)} ariaLabel={t("Minecraft version", "Версия Minecraft")} onChange={(version) => { const compatible = loadersForVersion(version); void updateSelected(compatible.includes(selected.loader) ? { gameVersion: version } : { gameVersion: version, loader: "vanilla" }); }} /> : <input value={selected.gameVersion} onChange={(event) => void updateSelected({ gameVersion: event.target.value })} placeholder="1.21.1" />}</label><label>{t("Loader", "Загрузчик")}<Dropdown value={selected.loader} options={withFallback(selectedLoaders ?? loadersForVersion(selected.gameVersion), selected.loader)} ariaLabel={t("Loader", "Загрузчик")} onChange={(loader) => { const next = loader as ModLoader; const versions = versionsForLoader(next); void updateSelected(versions.includes(selected.gameVersion) ? { loader: next } : { loader: next, gameVersion: versions[0] ?? selected.gameVersion }); }} /></label></div><label>{t("Loader version", "Версия загрузчика")}{selected.loader === "vanilla" ? <span className="muted">{t("Not needed for vanilla", "Не требуется для ванильной версии")}</span> : loaderVersions ? <Dropdown value={selected.loaderVersion?.trim() || t("Latest", "Последняя")} options={(selected.loaderVersion?.trim() ? [t("Latest", "Последняя"), selected.loaderVersion.trim(), ...loaderVersions.filter((item) => item !== selected.loaderVersion?.trim())] : [t("Latest", "Последняя"), ...loaderVersions])} ariaLabel={t("Loader version", "Версия загрузчика")} onChange={(label) => void updateSelected({ loaderVersion: label === t("Latest", "Последняя") ? "" : label })} /> : <input value="" disabled placeholder={t("Loading versions...", "Загрузка версий...")} />}</label></div>}
                {instanceTab === "files" && <div className="settings-content" key={`files-${selected.id}`}><div className="surface-heading"><Folder size={19} /><div><h3>{t("Local files", "Локальные файлы")}</h3><span>{t("Everything inside this instance folders, including files added by hand.", "Всё содержимое папок инстанции, включая файлы, добавленные вручную.")}</span></div></div><div className="button-row"><button onClick={() => void refreshLocalContent()} disabled={busy}><RefreshCw size={15} /> {t("Refresh", "Обновить")}</button><button onClick={() => void openSelectedFolder()}><FolderOpen size={15} /> {t("Open folder", "Открыть папку")}</button><input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder={t("Search files", "Поиск файлов")} aria-label={t("Search files", "Поиск файлов")} /><label className="sort-label">{t("Sort by:", "Сортировать по:")}<Dropdown value={t(fileSortOptions.find((option) => option.id === fileSort)?.label ?? "Name A-Z", fileSortLabelRu[fileSortOptions.find((option) => option.id === fileSort)?.label ?? ""] ?? "")} options={fileSortOptions.map((option) => t(option.label, fileSortLabelRu[option.label] ?? option.label))} ariaLabel={t("Sort files", "Сортировка файлов")} onChange={(label) => { const found = fileSortOptions.find((option) => option.label === label || t(option.label, fileSortLabelRu[option.label] ?? option.label) === label); if (found) setFileSort(found.id); }} /></label></div>{localContent === null ? <span className="muted">{t("Reading instance folders...", "Чтение папок инстанции...")}</span> : fileGroups.map((group) => { const rows = filterSortFiles(localContent.filter((item) => item.kind === group.id), fileQuery, fileSort); return <div key={group.id} className="file-group"><div className="section-title">{t(group.label, group.labelRu)} · {rows.filter((row) => row.enabled).length}/{rows.length}</div>{rows.length ? rows.map((item) => <div key={item.kind + item.fileName} className={item.enabled ? "file-row" : "file-row disabled"}>{item.iconUrl ? <img className="file-icon" src={item.iconUrl} alt="" /> : <div className="file-icon mod-icon">{item.displayName[0] ?? "?"}</div>}<div className="file-main"><strong>{item.displayName}</strong><small className="muted">{item.fileName} · {formatBytes(item.size)}{item.modified ? ` · ${formatDateTime(item.modified)}` : ""}</small></div><div className="file-side">{item.source === "modrinth" ? <span className="tag-chip">Modrinth</span> : item.source === "manual" ? <span className="tag-chip manual">{t("Manual", "Вручную")}</span> : <span className="tag-chip missing">{t("Missing file", "Файл отсутствует")}</span>}{item.enabled ? null : <span className="tag-chip">{t("Off", "Отключено")}</span>}{item.source !== "missing" ? <button type="button" title={item.enabled ? t("Disable", "Выключить") : t("Enable", "Включить")} onClick={() => void toggleLocalItem(item)} disabled={busy}>{item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}</button> : null}<button type="button" title={t("Delete", "Удалить")} onClick={() => void removeLocalItem(item)} disabled={busy}><Trash2 size={15} /></button></div></div>) : <span className="muted">{t("Empty — drop files into the folder or install from Content.", "Пусто — закиньте файлы в папку или поставьте из контента.")}</span>}</div>; })}</div>}
                {instanceTab === "runtime" && <div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>RAM</h3><span>{t("Allocated memory for this instance only.", "Объём памяти только для этой инстанции.")}</span></div></div><label>{t("Allocated RAM", "Объём памяти")}<MemorySlider value={selected.maxMemoryMb ?? bootstrap.settings.maxMemoryMb} onChange={(next) => void updateSelected({ maxMemoryMb: next })} /></label><label>{t("Extra JVM flags", "Дополнительные флаги JVM")}<textarea value={selected.extraJvmArgs ?? ""} rows={2} spellCheck={false} placeholder={bootstrap.settings.extraJvmArgs || "-XX:+UseG1GC -XX:MaxGCPauseMillis=50"} onChange={(event) => void updateSelected({ extraJvmArgs: event.target.value })} /></label></div>}
                {instanceTab === "logs" && <div className="settings-content"><div className="surface-heading"><ScrollText size={19} /><div><h3>{t("Logs", "Журнал")}</h3><span>{isSelectedRunning ? t("Live tail · running", "Текущий журнал · запущено") : t("Launch the instance to see live logs.", "Запустите инстанцию, чтобы увидеть журнал.")}</span></div></div><div className="button-row"><button onClick={() => void refreshInstanceLogs(false)} disabled={busy}><RefreshCw size={15} /> Refresh</button><button onClick={() => void openSelectedFolder()}><FolderOpen size={15} /> Open folder</button><button type="button" onClick={() => setLogsFollow((v) => !v)} title={t("Auto-scroll to bottom on new lines", "Автоматическая прокрутка вниз при новых строках")}>{logsFollow ? t("Follow: on", "Автопрокрутка: вкл") : t("Follow: off", "Автопрокрутка: выкл")}</button></div>{instanceLogs === null ? <span className="muted">{t("No live logs. Launch the instance.", "Журнал пуст. Запустите инстанцию.")}</span> : !instanceLogs.hasLog ? <span className="muted">{t("Starting... waiting for log.", "Запуск... Ожидание журнала.")}</span> : <>{crashAssist && !isSelectedRunning && !isLaunching ? <div className="crash-banner" role="alert"><XCircle size={17} /><div><strong>{crashAssist.title}</strong><span>{crashAssist.hint}</span></div><button onClick={() => void copyCrashAssist()} title={t("Copy reason and log tail", "Скопировать причину и хвост журнала")}><Copy size={14} /> {t("Copy", "Копировать")}</button></div> : null}<pre ref={logPreRef} className="log-view">{instanceLogs.log || t("(empty log)", "(журнал пуст)")}</pre>{instanceLogs.plan ? <details className="log-plan"><summary>{t("Launch plan", "План запуска")}</summary><pre className="log-view small">{instanceLogs.plan}</pre></details> : null}</>}</div>}
                {instanceTab === "content" && <div className={contentExiting ? "settings-content content-content content-exiting" : "settings-content content-content"} key={`${contentType}-${selected.id}`}><div className="surface-heading"><PackageSearch size={19} /><div><h3>{t(`Discover ${contentLabel(contentType).toLowerCase()}`, `Обзор ${(contentTypes.find((c) => c.id === contentType)?.labelRu ?? "").toLowerCase()}`)}</h3><span>{t(`Browse Modrinth for ${selected.gameVersion} / ${selected.loader}.`, `Modrinth: ${selected.gameVersion} / ${selected.loader}.`)}</span></div></div><nav className="content-types" aria-label={t("Content type", "Тип контента")}>{visibleContentTypes.map(({ id, label, labelRu, icon: Icon }) => <button key={id} className={contentType === id ? "content-type active" : "content-type"} onClick={() => switchContentType(id)}><Icon size={15} /><span>{t(label, labelRu)}</span></button>)}</nav><div className="content-browser"><div className="content-main"><div className="search-row"><input value={modQuery} onChange={(event) => setModQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runContentSearch({ page: 1 }); }} placeholder={t("Search or leave empty to browse", "Поиск. Оставьте пустым, чтобы показать всё")} /><button onClick={() => void runContentSearch({ page: 1 })} disabled={busy}><Search size={16} /> {t("Search", "Найти")}</button></div><div className="browse-controls"><label className="sort-label">{t("Sort by:", "Сортировать по:")}<Dropdown value={t(sortLabel, sortLabelRu[sortLabel] ?? sortLabel)} options={sortOptions.map((option) => t(option.label, sortLabelRu[option.label] ?? option.label))} ariaLabel={t("Sort by", "Сортировка")} onChange={(label) => { const found = sortOptions.find((option) => option.label === label || t(option.label, sortLabelRu[option.label] ?? option.label) === label); if (found) void runContentSearch({ page: 1, sort: found.id }); }} /></label><label className="sort-label">{t("View:", "На странице:")}<Dropdown value={String(contentLimit)} options={["10", "20", "50"]} ariaLabel={t("Results per page", "Результатов на странице")} onChange={(label) => void runContentSearch({ page: 1, limit: Number(label) })} /></label>{totalHits > 0 ? <span className="muted">{totalHits} {t(totalHits === 1 ? "result" : "results", totalHits % 10 === 1 && totalHits % 100 !== 11 ? "результат" : totalHits % 10 >= 2 && totalHits % 10 <= 4 && (totalHits % 100 < 10 || totalHits % 100 >= 20) ? "результата" : "результатов")}</span> : null}</div><div className={busy ? "mod-results refreshing" : "mod-results"}>{visibleResults.map((result) => <article key={`${result.projectType}-${result.id}`} className="mod-card">{result.iconUrl ? <img className="mod-card-icon" src={result.iconUrl} alt="" /> : <div className="mod-card-icon mod-icon">{result.title[0]}</div>}<div className="mod-card-main"><div className="mod-card-title"><strong>{result.title}</strong>{result.author ? <span>by {result.author}</span> : null}</div><p>{result.summary}</p>{result.categories.length ? <div className="mod-card-tags">{result.categories.slice(0, 5).map((category) => <span key={category} className="tag-chip">{category}</span>)}</div> : null}</div><div className="mod-card-side">{installedProjectIds.has(result.id) ? <span className="installed-badge"><Check size={14} /> {t("Installed", "Установлен")}</span> : <button className="install-button" onClick={() => void installContent(result)} disabled={busy || !isInstallable(result) || downloadingIds.includes(result.id)} title={result.projectType === "modpack" ? t(`Download ${result.title}`, `Скачать ${result.title}`) : t(`Install ${result.title}`, `Установить ${result.title}`)}>{downloadingIds.includes(result.id) ? <><RefreshCw size={14} className="spin" /> {t("Downloading", "Загрузка")} {transferLabel(transferPct[`mod:${result.id}`] ?? transferPct[`modpack:${result.id}`]) ?? "..."}</> : <><Plus size={14} /> {t("Install", "Установить")}</>}</button>}{result.projectType === "modpack" && !installedProjectIds.has(result.id) ? <button className="install-button" onClick={() => void installIntoThis(result)} disabled={busy || !isInstallable(result) || downloadingIds.includes(result.id)} title={t("Install into this instance", "Установить в эту инстанцию")}><Plus size={14} /> {t("Into this", "В инстанцию")}</button> : null}<div className="mod-card-stats"><span><Download size={13} /> {formatDownloads(result.downloads)}</span>{typeof result.follows === "number" ? <span><Heart size={13} /> {formatDownloads(result.follows)}</span> : null}</div>{result.dateModified ? <small className="muted"><Clock size={12} /> {formatRelative(result.dateModified)}</small> : null}</div></article>)}</div>{totalPages > 1 ? <nav className="pages" aria-label={t("Result pages", "Страницы результатов")}><button className="page-button" disabled={contentPage <= 1 || busy} aria-label={t("Previous page", "Предыдущая страница")} onClick={() => void runContentSearch({ page: contentPage - 1 })}><ChevronLeft size={15} /></button>{pageList(contentPage, totalPages).map((page, index) => page === "gap" ? <span key={`gap-${index}`} className="page-gap">…</span> : <button key={page} className={page === contentPage ? "page-button active" : "page-button"} disabled={busy} onClick={() => void runContentSearch({ page })}>{page}</button>)}<button className="page-button" disabled={contentPage >= totalPages || busy} aria-label={t("Next page", "Следующая страница")} onClick={() => void runContentSearch({ page: contentPage + 1 })}><ChevronRight size={15} /></button></nav> : null}</div><aside className="content-filters"><div className="filter-row"><div><strong>{t("Hide content already installed", "Скрыть уже установленное")}</strong></div><button type="button" role="switch" aria-checked={hideInstalled} className="switch" onClick={() => setHideInstalled((value) => !value)}><span className="knob" /></button></div><div className="filter-group"><div className="section-title">{t("Game version", "Версия игры")}</div>{versionUnlocked ? <Dropdown value={versionOverride ?? selected.gameVersion} options={gameVersions ?? [selected.gameVersion]} ariaLabel={t("Game version filter", "Фильтр версии игры")} onChange={(version) => { setVersionOverride(version); void runContentSearch({ page: 1, versions: [version] }); }} /> : <><span className="filter-lock">{selected.gameVersion}</span><p className="muted">{t("Game version is provided by the instance. Unlocking may show incompatible content.", "Версия определяется инстанцией. После разблокировки может отображаться несовместимый контент.")}</p><button onClick={() => { setVersionUnlocked(true); setVersionOverride(selected.gameVersion); }}><Lock size={14} />{t("Unlock filter", "Разблокировать")}</button></>}</div>{(contentType === "mod" || contentType === "modpack") ? <div className="filter-group"><div className="section-title">{t("Loader", "Загрузчик")}</div>{loaderUnlocked ? <Dropdown value={loaderOverride ?? selected.loader} options={loaderFilterOptions} ariaLabel={t("Loader filter", "Фильтр загрузчика")} onChange={(loader) => { setLoaderOverride(loader); void runContentSearch({ page: 1, loaders: [loader] }); }} /> : <><span className="filter-lock">{selected.loader}</span><button onClick={() => { setLoaderUnlocked(true); setLoaderOverride(selected.loader === "vanilla" ? "fabric" : selected.loader); }}><Lock size={14} />{t("Unlock filter", "Разблокировать")}</button></>}</div> : null}<div className="filter-group"><div className="section-title">{t("Categories", "Категории")}</div><div className="filter-checks">{categoryTags.length ? categoryTags.map((tag) => <label key={tag} className="filter-check"><input type="checkbox" checked={selectedCategories.includes(tag)} onChange={() => toggleCategory(tag)} />{tag}</label>) : <span className="muted">{t("No categories", "Нет категорий")}</span>}</div></div></aside></div></div>}
              </section>
            </> : <div className="blank-workspace"><Boxes size={34} /><h2>{t("Select an instance", "Выберите инстанцию")}</h2></div>}
          </section>
        </main>
      )}

      {section === "launcher" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">{t("Application", "Приложение")}</span><h2>{t("Launcher settings", "Настройки лаунчера")}</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Globe size={19} /><div><h3>{t("Language", "Язык")}</h3><span>{t("Interface language.", "Язык интерфейса.")}</span></div></div><label>{t("Language", "Язык")}<Dropdown value={lang === "ru" ? "Русский" : "English"} options={["English", "Русский"]} ariaLabel={t("Language", "Язык")} onChange={(label) => void setLanguage(label === "Русский" ? "ru" : "en")} /></label></div></section><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Settings size={19} /><div><h3>{t("Memory", "Память")}</h3><span>{t("Default allocated RAM for instances.", "Объём памяти по умолчанию для инстанций.")}</span></div></div><label>{t("Allocated RAM", "Объём памяти")}<MemorySlider value={settingsDraft.maxMemoryMb} onChange={(next) => setSettingsDraft({ ...settingsDraft, maxMemoryMb: next })} /></label><label>{t("Extra JVM flags", "Дополнительные флаги JVM")}<textarea value={settingsDraft.extraJvmArgs} rows={2} spellCheck={false} placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" onChange={(event) => setSettingsDraft({ ...settingsDraft, extraJvmArgs: event.target.value })} /></label></div><button className="primary-button save-button" onClick={saveSettings}><Save size={16} /> {t("Save settings", "Сохранить настройки")}</button></section><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>{t("Java installations", "Установленные версии Java")}</h3><span>{t("One runtime per Minecraft requirement. The launcher picks the right one automatically.", "Для каждого требования Minecraft — своя среда выполнения. Программа сама выберет подходящую.")}</span></div></div><div className="java-rows">{javaInstalls ? javaInstalls.map((installation) => <div key={installation.major} className="java-row"><div className="java-row-head"><strong>Java {installation.major} {t("location", "путь")}</strong>{installation.valid ? <CheckCircle2 size={17} className="java-status ok" /> : <XCircle size={17} className="java-status bad" />}</div><input value={installation.path} readOnly placeholder={t("Not installed", "Не установлена")} /><div className="java-actions"><button onClick={() => void javaAction(installation.major, "install")} disabled={javaBusy !== null}><Download size={15} /> {t("Install recommended", "Установить рекомендуемую")}</button><button onClick={() => void javaAction(installation.major, "detect")} disabled={javaBusy !== null}><RefreshCw size={15} /> {t("Detect", "Найти")}</button><button onClick={() => void javaAction(installation.major, "browse")} disabled={javaBusy !== null}><FolderOpen size={15} /> {t("Browse", "Выбрать")}</button></div><small className="muted">{javaBusy === installation.major ? t("Working...", "Выполняется...") : installation.message}</small></div>) : <span className="muted">{t("Loading Java installations...", "Загрузка установленных версий Java...")}</span>}</div></div></section></main>}

      {section === "visuals" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">{t("Appearance", "Внешний вид")}</span><h2>{t("Visuals", "Оформление")}</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Palette size={19} /><div><h3>{t("Theme", "Тема")}</h3><span>{t("Pick a parameter, choose any color. Applied instantly.", "Выберите параметр и цвет. Изменения применяются сразу.")}</span></div></div><div className="visuals-layout"><div className="visuals-main"><div className="preset-row">{THEME_PRESETS.map((item) => <button key={item.id} type="button" onClick={() => applyPreset(item.id)}>{t(item.label, item.labelRu)}</button>)}</div><div className="theme-grid">{THEME_GROUPS.map((group) => <div key={group} className="theme-group-block anim-stagger"><span className="theme-group">{t(group, THEME_TOKENS.find((token) => token.group === group)?.groupRu ?? group)}</span>{THEME_TOKENS.filter((token) => token.group === group).map((token) => { const value = theme[token.id] ?? token.default; return <label key={token.id} className="theme-row" onMouseEnter={() => setPreviewToken(token.id)}><input type="color" value={value} onChange={(event) => setToken(token.id, event.target.value)} aria-label={t(token.label, token.labelRu)} /><span className="theme-dot" style={{ background: value }} /><span className="theme-name">{t(token.label, token.labelRu)}</span><code>{value}</code></label>; })}</div>)}</div></div>{(() => { const def = THEME_TOKENS.find((item) => item.id === previewToken) ?? THEME_TOKENS[0]; return <div className="preview-pane"><span className="eyebrow">{t("Preview", "Предпросмотр")}</span><strong>{t(def.label, def.labelRu)}</strong><ThemePreview id={previewToken} t={t} /></div>; })()}</div></div></section><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Sparkles size={19} /><div><h3>{t("Motion", "Анимации")}</h3><span>{t("Cursor glow and animations.", "Свечение курсора и анимации.")}</span></div></div><div className="filter-row"><strong>{t("Cursor glow", "Свечение курсора")}</strong><button type="button" className="switch" role="switch" aria-checked={glowOn} aria-label={t("Cursor glow", "Свечение курсора")} onClick={() => setGlowEnabled(!glowOn)}><span className="knob" /></button></div><label>{t("Glow size", "Размер свечения")} · {glowSize}%<input type="range" min={10} max={220} step={5} value={glowSize} disabled={!glowOn} onChange={(event) => setGlowSizeValue(Number(event.target.value))} aria-label={t("Glow size", "Размер свечения")} /></label><label>{t("Glow follow speed", "Скорость следования")} · {glowSpeed}%<input type="range" min={20} max={150} step={10} value={glowSpeed} disabled={!glowOn} onChange={(event) => setGlowSpeedValue(Number(event.target.value))} aria-label={t("Glow follow speed", "Скорость следования")} /></label><div className="filter-row"><strong>{t("Animations", "Анимации")}</strong><button type="button" className="switch" role="switch" aria-checked={animsOn} aria-label={t("Animations", "Анимации")} onClick={() => setAnimsEnabled(!animsOn)}><span className="knob" /></button></div></div></section></main>}

      {section === "skins" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">{t("Identity", "Профиль")}</span><h2>{t("Skins", "Скины")}</h2><span className="status-line">{status}</span></div></header><section className={dropActive ? "settings-surface skins-surface dragging" : "settings-surface skins-surface"} onDragOver={(event) => { event.preventDefault(); setDropActive(true); }} onDragLeave={() => setDropActive(false)} onDrop={dropSkin}><div className="settings-content"><div className="surface-heading"><Shirt size={19} /><div><h3>{t("Skin selector", "Выбор скина")}</h3><span>{t("Playing as", "Вы играете как")} {activeAccount?.profileName ?? activeAccount?.status}{activeAccount?.kind === "ely" ? t(". Ely.by skin below.", ". Скин Ely.by — ниже.") : activeAccount?.status === "signed-in" ? t(". Use uploads to Mojang.", ". Загрузка выполняется в Mojang.") : t(". Offline profile.", ". Офлайн-профиль.")}</span></div></div>{(() => { const list = canEditSkins ? (skins ?? []) : []; const preview = list.find((item) => item.id === (selectedSkinId ?? activeSkinId)) ?? list.find((item) => item.id === activeSkinId) ?? list[0] ?? null; const cape = (capes ?? []).find((item) => item.active) ?? null; return <div className="skins-layout"><div className="skin-stage"><SkinViewer3D dataUrl={isElyAccount ? (elySkin?.dataUrl ?? null) : (preview?.dataUrl ?? null)} slim={isElyAccount ? (elySkin?.slim ?? false) : (preview?.slim ?? false)} capeUrl={cape?.url ?? null} /><strong>{isElyAccount ? `${activeAccount?.profileName ?? "Ely"} · Ely.by` : (preview?.name ?? t("No skin yet", "Скин не выбран"))}</strong><span className="muted">{canEditSkins ? t("Drag to rotate · scroll to zoom · drop a PNG anywhere", "Вращение — перетаскивание, масштаб — колесо мыши. PNG-файл можно перетащить в любое место") : t("Drag to rotate · scroll to zoom", "Вращение — перетаскивание, масштаб — колесо мыши")}</span></div><div className="skins-side"><span className="section-title">{t("Saved skins", "Сохранённые скины")}</span>{skins === null ? <span className="muted">{t("Loading skins...", "Загрузка скинов...")}</span> : skins.length ? <div className="skin-grid">{skins.map((skin) => <div key={skin.id} role="button" tabIndex={0} onClick={() => setSelectedSkinId(skin.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedSkinId(skin.id); }} className={skin.id === activeSkinId ? "skin-card active" : skin.id === (selectedSkinId ?? activeSkinId) ? "skin-card selected" : "skin-card"}><SkinPreview dataUrl={skin.dataUrl} slim={skin.slim} /><strong>{skin.name}</strong><div className="button-row skin-arms"><button type="button" className={skin.slim ? "" : "content-type active"} onClick={(event) => { event.stopPropagation(); void setSkinModel(skin.id, false); }} disabled={skinBusy || !canEditSkins}>{t("Wide", "Классическая")}</button><button type="button" className={skin.slim ? "content-type active" : ""} onClick={(event) => { event.stopPropagation(); void setSkinModel(skin.id, true); }} disabled={skinBusy || !canEditSkins}>{t("Slim", "Худая")}</button></div><div className="button-row skin-actions"><button type="button" className={skin.id === activeSkinId ? "primary-button" : ""} onClick={(event) => { event.stopPropagation(); void activateSkin(skin.id, skin.name); }} disabled={skinBusy || !canEditSkins || skin.id === activeSkinId}>{skin.id === activeSkinId ? <><Check size={15} /> {t("Active", "Активен")}</> : t("Use skin", "Выбрать скин")}</button><button type="button" onClick={(event) => { event.stopPropagation(); void removeSkin(skin.id, skin.name); }} disabled={skinBusy || !canEditSkins} title={t("Delete skin", "Удалить скин")}><Trash2 size={15} /></button></div></div>)}</div> : canEditSkins ? <span className="muted">{t("No skins yet. Upload a 64x64 PNG texture.", "Скинов пока нет. Загрузите PNG-файл 64x64.")}</span> : isElyAccount ? (elySkin === undefined ? <span className="muted">{t("Loading Ely.by skin...", "Загрузка скина Ely.by...")}</span> : elySkin ? <span className="muted">{t("Ely.by skin is shown in the preview.", "Скин Ely.by показан в области предпросмотра.")}</span> : <span className="muted">{t("No skin on this Ely.by account.", "На этой учётной записи Ely.by нет скина.")}</span>) : <span className="muted">{t("Sign in with Microsoft to see your skins.", "Войдите через Microsoft, чтобы увидеть скины.")}</span>}<div className="button-row"><label className={canEditSkins ? "file-pick" : "file-pick disabled"}><Plus size={16} /> {t("Upload skin", "Загрузить скин")}<input type="file" accept=".png,image/png" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadSkin(file); }} /></label></div>{canEditSkins ? null : <span className="muted">{t("Skins are locked for offline profiles. Sign in with Microsoft to change them.", "Скины недоступны для офлайн-профилей. Войдите через Microsoft, чтобы их изменять.")}</span>}<span className="section-title">{t("Cape", "Плащ")}</span>{capes === null ? <span className="muted">{t("Loading capes...", "Загрузка плащей...")}</span> : activeAccount?.status !== "signed-in" ? <span className="muted">{t("Sign in with Microsoft to use capes.", "Войдите через Microsoft, чтобы использовать плащи.")}</span> : capes.length ? <div className="cape-row"><button type="button" className={capes.some((item) => item.active) ? "cape-pick" : "cape-pick active"} onClick={() => void equipCape(null)} disabled={skinBusy} title={t("No cape", "Без плаща")}>{t("None", "Нет")}</button>{capes.map((item) => <button key={item.id} type="button" className={item.active ? "cape-pick active" : "cape-pick"} onClick={() => void equipCape(item.id)} disabled={skinBusy} title={item.alias}><CapeThumb url={item.url} /></button>)}</div> : <span className="muted">{t("No capes on this account. Custom capes cannot be uploaded to Mojang.", "На этой учётной записи нет плащей. Собственные плащи загрузить в Mojang нельзя.")}</span>}</div></div>; })()}</div></section></main>}

      {section === "accounts" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">{t("Identity", "Профиль")}</span><h2>{t("Account settings", "Аккаунты")}</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><User size={19} /><div><h3>{t("Playing as", "Вы играете как")}</h3><span>{t("Click an account to switch, no re-login needed.", "Щёлкните по учётной записи, чтобы переключиться без повторного входа.")}</span></div></div><div className="account-list">{bootstrap.accounts.map((item) => <div key={item.id} role="button" tabIndex={0} onClick={() => void switchAccount(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void switchAccount(item.id); }} className={item.id === activeAccount?.id ? "account-row active" : "account-row"}>{item.id === activeAccount?.id ? <span className="account-dot on" /> : <span className="account-dot" />}{item.kind === "microsoft" ? <KeyRound size={20} /> : <User size={20} />}<div><strong>{item.profileName ?? item.kind}</strong><span>{item.kind === "microsoft" ? t("Minecraft account", "Учётная запись Minecraft") : item.kind === "ely" ? "Ely.by" : t("Offline", "Офлайн")}</span></div><button type="button" title={t("Remove account", "Удалить учётную запись")} onClick={(event) => { event.stopPropagation(); void removeAccount(item.id, item.profileName ?? item.kind); }} disabled={busy}><Trash2 size={15} /></button></div>)}{bootstrap.accounts.length ? null : <span className="muted">{t("No accounts yet. Add one below.", "Учётных записей пока нет. Добавьте ниже.")}</span>}</div><div className="button-row"><button className="primary-button" onClick={beginLogin} disabled={busy}><Plus size={16} /> {t("Add account", "Добавить учётную запись")}</button></div></div><div className="settings-content bordered-top"><div className="surface-heading"><UserRoundCog size={19} /><div><h3>{t("Offline profile", "Офлайн-профиль")}</h3><span>{t("No Microsoft account needed.", "Учётная запись Microsoft не требуется.")}</span></div></div><label>{t("Username", "Имя пользователя")}<input value={offlineName} maxLength={16} onChange={(event) => setOfflineName(event.target.value)} placeholder={t("Player", "Игрок")} /></label><button onClick={useOfflineProfile} disabled={busy}><User size={16} /> {t("Add offline profile", "Добавить офлайн-профиль")}</button></div><div className="settings-content bordered-top"><div className="surface-heading"><KeyRound size={19} /><div><h3>Ely.by {t("account", "учётная запись")}</h3><span>{t("Login, skins and Ely servers.", "Вход, скины и серверы Ely.")}</span></div></div><label>{t("Username or e-mail", "Имя пользователя или эл. почта")}<input value={elyName} onChange={(event) => setElyName(event.target.value)} placeholder="nickname" /></label><label>{t("Password", "Пароль")}<input type="password" value={elyPassword} onChange={(event) => setElyPassword(event.target.value)} placeholder="••••••••" /></label><label>{t("2FA token (if enabled)", "2FA-код (если включён)")}<input value={elyTotp} inputMode="numeric" onChange={(event) => setElyTotp(event.target.value.replace(/[^0-9]/g, ""))} placeholder="123456" /></label><button className="primary-button" onClick={elyLogin} disabled={busy}><KeyRound size={16} /> {t("Add Ely account", "Добавить учётную запись Ely")}</button></div><div className="settings-content bordered-top"><div className="readonly-path"><HardDrive size={16} /><span>{bootstrap.storagePath}</span></div></div></section></main>}
      </div>
      {confirmDelete && selected ? <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}><div className="modal-card" role="alertdialog" aria-label={t("Delete instance", "Удаление инстанции")} onClick={(event) => event.stopPropagation()}><h3>{t("Delete", "Удалить")} {selected.name}?</h3><p className="muted">{t("The instance folder and ALL its files — worlds, mods, configs — will be permanently removed. This cannot be undone.", "Папка инстанции и все её файлы (миры, моды, конфигурации) будут удалены навсегда.")}</p><div className="button-row modal-actions"><button onClick={() => setConfirmDelete(false)}>{t("Cancel", "Отмена")}</button><button className="danger-button" onClick={() => { setConfirmDelete(false); void removeSelected(); }} disabled={busy}><Trash2 size={15} /> {t("Delete", "Удалить")}</button></div></div></div> : null}
      {modpackTarget && selected ? <div className="modal-backdrop" onClick={() => void cancelModpackTarget()}><div className="modal-card" role="alertdialog" aria-label={t("Version mismatch", "Несовпадение версий")} onClick={(event) => event.stopPropagation()}><h3>{t("Install", "Установить")} {modpackTarget.info.packName} {t("into", "в")} {selected.name}?</h3><p className="muted">{t("Pack wants", "Модпаку требуется")} {modpackTarget.info.packGameVersion} / {modpackTarget.info.packLoader}, {t("instance is", "в инстанции")} {selected.gameVersion} / {selected.loader}. {t("Files may not work.", "Файлы могут не работать.")}</p><div className="button-row modal-actions"><button onClick={() => void cancelModpackTarget()}>{t("Cancel", "Отмена")}</button><button className="primary-button" onClick={() => void confirmModpackTarget()} disabled={busy}><Plus size={15} /> {t("Install anyway", "Всё равно установить")}</button></div></div></div> : null}
      {exportModal && selected ? <div className="modal-backdrop" onClick={() => setExportModal(null)}><div className="modal-card export-modal" role="dialog" aria-label="Export modpack" onClick={(event) => event.stopPropagation()}><div className="export-head"><Archive size={20} /><div><h3>{t("Export modpack", "Экспорт модпака")}</h3><span className="muted">{selected.name} · {exportModal.entries.filter((e) => exportModal.checked[e.name]).length} / {exportModal.entries.length} · {formatBytes(exportModal.entries.filter((e) => exportModal.checked[e.name]).reduce((sum, e) => sum + e.size, 0))}</span></div><button type="button" className="titlebar-button" onClick={() => setExportModal(null)} aria-label={t("Close", "Закрыть")}><X size={15} /></button></div><div className="button-row export-quick"><button onClick={() => setExportModal((m) => m ? { ...m, checked: Object.fromEntries(m.entries.map((e) => [e.name, true])) } : m)}>{t("Select all", "Выбрать всё")}</button><button onClick={() => setExportModal((m) => m ? { ...m, checked: {} } : m)}>{t("Clear", "Очистить")}</button></div><div className="export-rows">{exportModal.entries.map((entry) => { const on = !!exportModal.checked[entry.name]; return <button key={entry.name} type="button" className={on ? "export-row on" : "export-row"} onClick={() => setExportModal((m) => m ? { ...m, checked: { ...m.checked, [entry.name]: !m.checked[entry.name] } } : m)}><span className="export-check">{on ? <Check size={14} /> : null}</span>{entry.isDir ? <Folder size={17} /> : <FileText size={17} />}<span className="export-name"><strong>{entry.name}</strong><small className="muted">{formatBytes(entry.size)}{entry.modified ? ` · ${formatDateTime(entry.modified)}` : ""}</small></span></button>; })}</div><div className="button-row modal-actions"><button onClick={() => setExportModal(null)}>{t("Cancel", "Отмена")}</button><button className="primary-button" onClick={() => void confirmExport()} disabled={busy || !exportModal.entries.some((e) => exportModal.checked[e.name])}><Archive size={15} /> {t("Export", "Экспортировать")}</button></div></div></div> : null}
    </div>
  );
}
