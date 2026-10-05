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
  Folder,
  FolderCog,
  FolderOpen,
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
type InstanceTab = "general" | "versions" | "content" | "files" | "runtime";

const loaders: ModLoader[] = ["vanilla", "fabric", "forge", "quilt", "neoforge"];
const defaultCreateForm = { name: "New Instance", gameVersion: "1.21.1", loader: "fabric" as ModLoader, loaderVersion: "" };
const contentTypes = [
  { id: "mod" as const, label: "Mods", icon: PackageSearch },
  { id: "resourcepack" as const, label: "Resource packs", icon: Image },
  { id: "shader" as const, label: "Shaders", icon: Sparkles },
  { id: "datapack" as const, label: "Data packs", icon: Database },
  { id: "modpack" as const, label: "Modpacks", icon: Archive }
];

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
const fileGroups: Array<{ id: LocalContentKind; label: string }> = [
  { id: "mod", label: "Mods" },
  { id: "resourcepack", label: "Resource packs" },
  { id: "shader", label: "Shaders" },
  { id: "datapack", label: "Data packs" }
];

function withFallback<T>(options: T[], current: T): T[] {
  return options.includes(current) ? options : [current, ...options];
}

function contentLabel(type?: ModrinthProjectType): string {
  return contentTypes.find((item) => item.id === (type ?? "mod"))?.label ?? "Content";
}

function MemorySlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const safe = Math.min(32768, Math.max(512, Math.round(value / 256) * 256 || 2048));
  const gb = (safe / 1024).toFixed(safe % 1024 === 0 ? 0 : 1);
  return (
    <div className="memory-slider">
      <input type="range" min={512} max={32768} step={256} value={safe} onChange={(event) => onChange(Number(event.target.value))} aria-label="Allocated RAM" />
      <span className="muted">{safe} MB · {gb} GB</span>
    </div>
  );
}

function isInstallable(result: ModSearchResult): boolean {
  return !result.id.includes("error") && !result.categories.includes("error");
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

function ThemePreview({ id }: { id: ThemeTokenId }) {
  switch (id) {
    case "background":
      return <div className="pv-window"><div className="pv-top" /><div className="pv-body"><div className="pv-side" /><div className="pv-main"><div className="pv-bar" /><div className="pv-bar short" /></div></div></div>;
    case "sidebar":
      return <div className="pv-sidebar"><span className="count-badge">2</span><button type="button" className="instance-button active"><span><strong>New Instance</strong><small>1.21.1 / fabric</small></span></button></div>;
    case "cards":
      return <div className="pv-cards"><div className="stat-card"><span className="stat-value">8</span><span className="stat-label">Mods</span></div><span className="pill">Modrinth<small>source tag</small></span></div>;
    case "inputs":
      return <div className="pv-col"><input value="1.21.1" readOnly aria-label="Preview input" /><button type="button" className="dropdown-button"><span>fabric</span></button></div>;
    case "borders":
      return <div className="pv-col"><div className="pv-bordered">Row one</div><div className="pv-bordered">Row two</div></div>;
    case "buttons":
      return <div className="button-row"><button type="button">Sample</button><button type="button" className="content-type active">Mods</button></div>;
    case "accent":
      return <div className="surface-heading"><Waypoints size={19} /><div><h3>Versions</h3></div></div>;
    case "active":
      return <nav className="instance-tabs"><button type="button" className="tab-button">General</button><button type="button" className="tab-button active">Versions</button></nav>;
    case "primary":
      return <button type="button" className="primary-button launch-button">Launch</button>;
    case "danger":
      return <div className="pv-col"><button type="button" className="danger-button">Delete instance</button><span className="muted">Folder is removed too</span></div>;
    case "glow":
      return <div className="pv-col"><button type="button">Hover me</button><span className="muted">Glow follows the cursor</span></div>;
    case "text":
      return <div className="preview-text"><strong>New Instance</strong><span>1.21.1 / fabric</span></div>;
    default:
      return <div className="preview-text"><span>Secondary text sample</span><span>Last activity</span></div>;
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
    try {
      if (dataUrl) {
        void Promise.resolve(viewer.loadSkin(dataUrl, { model: slim ? "slim" : "default" })).catch(() => undefined);
      } else {
        viewer.loadSkin(null);
      }
      if (capeUrl) {
        void Promise.resolve(viewer.loadCape(capeUrl)).catch(() => undefined);
      } else {
        viewer.resetCape();
      }
    } catch {
    }
  }, [dataUrl, slim, capeUrl]);

  return <canvas ref={canvasRef} className="skin-stage-canvas" />;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
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
      setStatus(error instanceof Error ? error.message : "Update download failed");
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await getLauncherApi().installUpdate();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Update install failed");
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
      setStatus(error instanceof Error ? error.message : "Failed to save theme");
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
    setStatus(`Theme: ${found.label}`);
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
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const contentAutoKey = useRef("");
  const [skins, setSkins] = useState<SkinInfo[] | null>(null);
  const [skinBusy, setSkinBusy] = useState(false);
  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(null);
  const [capes, setCapes] = useState<CapeInfo[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [windowDrag, setWindowDrag] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      setStatus("Sign in with Microsoft to change skins");
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
      setStatus(`Added skin ${file.name}`);
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
      setStatus(result.uploaded ? `Skin uploaded to Mojang: ${name}` : `Selected ${name}. Others see it on servers with skin plugins.`);
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
      setStatus(`Deleted skin ${name}`);
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
      setStatus(capeId ? "Cape equipped" : "Cape removed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to change cape");
    } finally {
      setSkinBusy(false);
    }
  }

  async function importMrpackByPath(filePath: string): Promise<void> {
    if (!/\.mrpack$/i.test(filePath)) {
      setStatus("Only .mrpack modpack files can be dropped here");
      return;
    }
    setBusy(true);
    const short = filePath.split(/[\\/]/).pop() ?? filePath;
    setStatus(`Importing ${short}...`);
    let startedId: string | null = null;
    try {
      const started = await getLauncherApi().importMrpackStart(filePath);
      startedId = started.instance.id;
      await refresh({ setReadyStatus: false });
      setSelectedId(started.instance.id);
      switchSection("instances");
      setMrpackProgress((current) => ({ ...current, [started.instance.id]: { done: 0, total: started.totalFiles } }));
      setInstanceStatus({ id: started.instance.id, message: `Importing ${started.instance.name}... 0%` });
      setStatus(`Importing ${started.instance.name}... 0%`);
      try {
        await getLauncherApi().importMrpackFiles(started.instance.id);
        await refresh({ setReadyStatus: false });
        setInstanceStatus({ id: started.instance.id, message: `Imported ${started.instance.name}` });
        setStatus(`Imported ${started.instance.name}`);
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
        setInstanceStatus({ id: startedId, message });
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
          setStatus("Could not read the dropped file");
          return;
        }
        const mrpack = paths.find((item) => /\.mrpack$/i.test(item));
        if (!mrpack) {
          setStatus("Only .mrpack modpack files can be dropped here");
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
      setStatus("Sign in with Microsoft to change skins");
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
  const [launchingIds, setLaunchingIds] = useState<string[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<{ id: string; message: string } | null>(null);

  function assertNotLaunching(): boolean {
    if (selected && launchingIds.includes(selected.id)) {
      setStatus(`Cancel the launch of ${selected.name} first`);
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
      setStatus(error instanceof Error ? error.message : "Failed to load Java installations");
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
    setStatus(action === "install" ? `Downloading Java ${major}...` : `Java ${major}: working...`);
    try {
      const api = getLauncherApi();
      const updated = action === "install" ? await api.installJava(major) : action === "detect" ? await api.detectJava(major) : await api.browseJava(major);
      if (updated) {
        setJavaInstalls((current) => current ? current.map((item) => item.major === major ? updated : item) : current);
        setStatus(updated.message);
      } else {
        setStatus("Browse cancelled");
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
  const headerStatus = selected !== null && instanceStatus?.id === selected.id ? instanceStatus.message : "";

  function say(message: string): void {
    if (selected) {
      setInstanceStatus({ id: selected.id, message });
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
      if (selected.loader && !list.includes(selected.loader)) {
        void updateSelected({ loader: "vanilla" });
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
      say(`Created ${instance.name}`);
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
      say(`Saved ${updated.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save instance");
    }
  }
  async function removeSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    setBusy(true);
    try {
      await getLauncherApi().removeInstance(selected.id);
      setSelectedId(null);
      await refresh();
      say(`Deleted ${selected.name} with all its files`);
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
      setLocalContent(await getLauncherApi().toggleLocalContent({ instanceId: selected.id, fileName: item.fileName }));
      say(`${item.enabled ? "Disabled" : "Enabled"} ${item.displayName}`);
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
      setLocalContent(await getLauncherApi().removeLocalContent({ instanceId: selected.id, fileName: item.fileName }));
      say(`Deleted ${item.displayName}`);
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
    say(`Preparing ${selected.gameVersion}...`);
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
    say("Cancelling launch...");
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
    const settings = await getLauncherApi().updateSettings(settingsDraft);
    setBootstrap((current) => current ? { ...current, settings } : current);
    setStatus("Settings saved");
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
      if (current && !versions.includes(current)) {
        void updateSelected({ loaderVersion: "" });
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
      loaders: overrides.loaders ?? (contentType === "mod" && loaderUnlocked && loaderOverride ? [loaderOverride] : [])
    };
  }

  async function runContentSearch(overrides: Partial<ContentQuery> = {}): Promise<void> {
    if (!selected) return setStatus("Select an instance first");
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
      say(`Found ${response.totalHits} ${contentLabel(contentType).toLowerCase()} on Modrinth`);
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
    if (!selected) return setStatus("Select an instance first");
    if (!assertNotLaunching()) return;
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
      say(`${result.projectType === "modpack" ? "Downloaded" : "Installed"} ${result.title}`);
    } catch (error) {
      say(error instanceof Error ? error.message : `Failed to download ${result.title}`);
    }
  }

  async function beginLogin(): Promise<void> {
    setBusy(true);
    setStatus("Starting Microsoft login...");
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
      setStatus(`Playing as ${name}`);
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
      setStatus(`Removed ${name}`);
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
      setStatus(`Offline profile: ${offlineName}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Offline profile failed");
    } finally {
      setBusy(false);
    }
  }

  async function elyLogin(): Promise<void> {
    setBusy(true);
    setStatus("Signing in with Ely.by...");
    try {
      await getLauncherApi().elyLogin(elyName, elyPassword, elyTotp || undefined);
      setElyPassword("");
      setElyTotp("");
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(`Ely.by as ${elyName}`);
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
    { id: "general" as const, label: "General", icon: SlidersHorizontal },
    { id: "versions" as const, label: "Versions", icon: Waypoints },
    { id: "content" as const, label: "Content", icon: PackageSearch },
    { id: "files" as const, label: "Files", icon: Folder },
    { id: "runtime" as const, label: "RAM", icon: Cpu }
  ];

  return (
      <div className="app-shell">
      {windowDrag ? <div className="drop-overlay"><div className="drop-overlay-card"><Archive size={28} /><strong>Drop .mrpack to create an instance</strong><span>Release to import the modpack</span></div></div> : null}
      <header className="titlebar" onDoubleClick={() => void getLauncherApi().toggleMaximize()}>
        <div className="titlebar-brand"><img src={appIcon} alt="" /><span>lynapp</span></div>
        <div className="titlebar-controls" onDoubleClick={(event) => event.stopPropagation()}>
          {update?.kind === "available" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void downloadUpdate()} title={`Download lynapp ${update.version ?? ""}`.trim()}><Download size={14} /> Update{update.version ? ` ${update.version}` : ""}</button> : null}
          {update?.kind === "downloading" ? <button type="button" className="titlebar-button titlebar-update" disabled title="Downloading update"><RefreshCw size={14} className="spin" /> {update.percent ?? 0}%</button> : null}
          {update?.kind === "ready" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void installUpdate()} title="Restart to install the update"><Check size={14} /> Restart</button> : null}
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().minimizeWindow()} aria-label="Minimize" title="Minimize"><Minus size={16} /></button>
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
          <button type="button" className="titlebar-button titlebar-close" onClick={() => void getLauncherApi().closeWindow()} aria-label="Close" title="Close"><X size={16} /></button>
        </div>
      </header>
      <div className="app-body">
      <aside className="icon-rail" aria-label="Launcher navigation">
        <nav className="rail-nav">
          <button className={section === "home" ? "rail-button active" : "rail-button"} onClick={() => switchSection("home")} aria-label="Home" title="Home"><House size={19} /></button>
          <button className={section === "instances" ? "rail-button active" : "rail-button"} onClick={() => switchSection("instances")} aria-label="Instances" title="Instances"><Layers3 size={19} /></button>
          <button className={section === "launcher" ? "rail-button active" : "rail-button"} onClick={() => switchSection("launcher")} aria-label="Launcher settings" title="Launcher settings"><Settings size={19} /></button>
          <button className={section === "visuals" ? "rail-button active" : "rail-button"} onClick={() => switchSection("visuals")} aria-label="Visuals" title="Visuals"><Palette size={19} /></button>
          <button className={section === "skins" ? "rail-button active" : "rail-button"} onClick={() => switchSection("skins")} aria-label="Skins" title="Skins"><Shirt size={19} /></button>
          <button className={section === "accounts" ? "rail-button active" : "rail-button"} onClick={() => switchSection("accounts")} aria-label="Account settings" title="Account settings"><UserRoundCog size={19} /></button>
        </nav>
        <button className="rail-button rail-refresh" onClick={() => { void refresh(); void refreshVersions(); }} aria-label="Refresh" title="Refresh"><RefreshCw size={17} /></button>
      </aside>

      {section === "home" && (
        <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
          <header className="workspace-header"><div><span className="eyebrow">Home</span><h2>Welcome back</h2><span className="status-line">{selected !== null && instanceStatus?.id === selected.id ? instanceStatus.message : status}</span></div></header>
          <section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Box size={19} /><div><h3>{selected?.name ?? "No instance yet"}</h3><span>{selected ? `${selected.gameVersion} / ${selected.loader}${selected.loaderVersion ? ` ${selected.loaderVersion}` : ""}` : "Create an instance to start playing."}</span></div></div><div className="button-row">{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> Cancel</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> Stop</> : <><Play size={17} /> Launch</>}</button>}{selected ? <button onClick={() => switchSection("instances")}><SlidersHorizontal size={16} /> Manage instance</button> : <button className="primary-button" onClick={() => switchSection("instances")}><Plus size={16} /> New instance</button>}</div></div></section>
          <div className="stat-grid anim-stagger"><div className="stat-card"><span className="stat-value">{bootstrap.instances.length}</span><span className="stat-label">Instances</span></div><div className="stat-card"><span className="stat-value">{totalMods}</span><span className="stat-label">Mods installed</span></div><div className="stat-card"><span className="stat-value">{runningIds.length}</span><span className="stat-label">Running now</span></div><div className="stat-card"><span className="stat-value">{lastActivity || "—"}</span><span className="stat-label">Last activity</span></div></div>
        </main>
      )}

      {section === "instances" && (
        <main className={sectionExiting ? "instances-workspace section-exiting" : "instances-workspace"}>
          <aside className="instance-sidebar">
            <div className="sidebar-heading"><div><span className="eyebrow">Library</span><h1>Instances</h1></div><span className="count-badge">{bootstrap.instances.length}</span></div>
            <div className="instance-list">
              {bootstrap.instances.map((instance) => { const progress = mrpackProgress[instance.id]; const launching = launchingIds.includes(instance.id); const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0; return <button key={instance.id} className={instance.id === selected?.id ? "instance-button active" : "instance-button"} onClick={() => setSelectedId(instance.id)} disabled={busy || !!progress}>{progress ? <span className="instance-progress"><span style={{ width: `${pct}%` }} /></span> : null}<Box size={18} /><span><strong>{instance.name}</strong><small>{progress ? `Importing... ${pct}%` : launching ? "Launching..." : `${instance.gameVersion} / ${instance.loader}`}</small></span>{progress || launching ? null : <ChevronRight size={16} />}</button>; })}
            </div>
            <form className="new-instance-form anim-stagger" onSubmit={(event) => { event.preventDefault(); void createInstance(); }}>
              <div className="form-caption"><Plus size={15} /> New instance</div>
              <input value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} placeholder="Instance name" />
              <div className="two-col">{gameVersions ? <Dropdown value={createForm.gameVersion} options={withFallback(versionsForLoader(createForm.loader), createForm.gameVersion)} ariaLabel="Minecraft version" onChange={(version) => { const compatible = loadersForVersion(version); setCreateForm((form) => ({ ...createForm, gameVersion: version, loader: compatible.includes(form.loader) ? form.loader : "vanilla" })); }} /> : <input value={createForm.gameVersion} onChange={(event) => setCreateForm({ ...createForm, gameVersion: event.target.value })} placeholder="1.21.1" />}<Dropdown value={createForm.loader} options={withFallback(createLoaders ?? loadersForVersion(createForm.gameVersion), createForm.loader)} ariaLabel="Loader" onChange={(loader) => { const next = loader as ModLoader; const versions = versionsForLoader(next); setCreateForm((form) => ({ ...form, loader: next, gameVersion: versions.includes(form.gameVersion) ? form.gameVersion : versions[0] ?? form.gameVersion })); }} /></div>
              <button className="primary-button" disabled={creating}><Plus size={16} /> Create</button><span className="muted">or drop a .mrpack anywhere</span>
            </form>
          </aside>

          <section className="instance-workspace">
            <header className="workspace-header"><div><span className="eyebrow">{headerStatus.trim() ? (selected?.name ?? "No instance selected") : "Instance"}</span>{headerStatus.trim() ? <h2 key="status-promoted" className="status-promoted">{headerStatus}</h2> : <h2 key="instance-name">{selected?.name ?? "No instance selected"}</h2>}{headerStatus.trim() ? null : <span className="status-line">{headerStatus}</span>}</div>{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> Cancel</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> Stop</> : <><Play size={17} /> Launch</>}</button>}</header>
            {selected ? <>
              <nav className="instance-tabs" aria-label="Instance settings">{instanceTabs.map(({ id, label, icon: Icon }) => <button key={id} className={instanceTab === id ? "tab-button active" : "tab-button"} onClick={() => switchTab(id)}><Icon size={16} />{label}</button>)}</nav>
              <section className={tabExiting ? "settings-surface tab-exiting" : "settings-surface"} key={instanceTab}>
                {instanceTab === "general" && <div className="settings-content"><div className="surface-heading"><FolderCog size={19} /><div><h3>General</h3><span>Identity and location for this installation.</span></div></div><label>Instance name<input value={selected.name} onChange={(event) => void updateSelected({ name: event.target.value })} /></label><div className="readonly-path"><HardDrive size={16} /><span>{selected.directory}</span><button type="button" className="path-open" onClick={() => void openSelectedFolder()} title="Open instance folder"><FolderOpen size={15} /></button></div><button className="danger-button" onClick={() => setConfirmDelete(true)} disabled={busy || isSelectedRunning} title={isSelectedRunning ? "Stop the instance first" : "Delete the instance and its folder"}><Trash2 size={16} /> Delete instance</button></div>}
                {instanceTab === "versions" && <div className="settings-content anim-stagger"><div className="surface-heading"><Waypoints size={19} /><div><h3>Versions</h3><span>Minecraft version and loader for this instance.</span></div></div><div className="two-col"><label>Minecraft version{gameVersions ? <Dropdown value={selected.gameVersion} options={withFallback(versionsForLoader(selected.loader), selected.gameVersion)} ariaLabel="Minecraft version" onChange={(version) => { const compatible = loadersForVersion(version); void updateSelected(compatible.includes(selected.loader) ? { gameVersion: version } : { gameVersion: version, loader: "vanilla" }); }} /> : <input value={selected.gameVersion} onChange={(event) => void updateSelected({ gameVersion: event.target.value })} placeholder="1.21.1" />}</label><label>Loader<Dropdown value={selected.loader} options={withFallback(selectedLoaders ?? loadersForVersion(selected.gameVersion), selected.loader)} ariaLabel="Loader" onChange={(loader) => { const next = loader as ModLoader; const versions = versionsForLoader(next); void updateSelected(versions.includes(selected.gameVersion) ? { loader: next } : { loader: next, gameVersion: versions[0] ?? selected.gameVersion }); }} /></label></div><label>Loader version{selected.loader === "vanilla" ? <span className="muted">Not needed for vanilla</span> : loaderVersions ? <Dropdown value={selected.loaderVersion?.trim() || "Latest"} options={(selected.loaderVersion?.trim() ? ["Latest", selected.loaderVersion.trim(), ...loaderVersions.filter((item) => item !== selected.loaderVersion?.trim())] : ["Latest", ...loaderVersions])} ariaLabel="Loader version" onChange={(label) => void updateSelected({ loaderVersion: label === "Latest" ? "" : label })} /> : <input value="" disabled placeholder="Loading versions..." />}</label></div>}
                {instanceTab === "files" && <div className="settings-content" key={`files-${selected.id}`}><div className="surface-heading"><Folder size={19} /><div><h3>Local files</h3><span>Everything inside this instance folders, including files added by hand.</span></div></div><div className="button-row"><button onClick={() => void refreshLocalContent()} disabled={busy}><RefreshCw size={15} /> Refresh</button><button onClick={() => void openSelectedFolder()}><FolderOpen size={15} /> Open folder</button></div>{localContent === null ? <span className="muted">Reading instance folders...</span> : fileGroups.map((group) => { const rows = localContent.filter((item) => item.kind === group.id); return <div key={group.id} className="file-group"><div className="section-title">{group.label} · {rows.filter((row) => row.enabled).length}/{rows.length}</div>{rows.length ? rows.map((item) => <div key={item.kind + item.fileName} className={item.enabled ? "file-row" : "file-row disabled"}>{item.iconUrl ? <img className="file-icon" src={item.iconUrl} alt="" /> : <div className="file-icon mod-icon">{item.displayName[0] ?? "?"}</div>}<div className="file-main"><strong>{item.displayName}</strong><small className="muted">{item.fileName} · {formatBytes(item.size)}{item.modified ? ` · ${formatDateTime(item.modified)}` : ""}</small></div><div className="file-side">{item.source === "modrinth" ? <span className="tag-chip">Modrinth</span> : item.source === "manual" ? <span className="tag-chip manual">Manual</span> : <span className="tag-chip missing">Missing file</span>}{item.enabled ? null : <span className="tag-chip">Off</span>}{item.source !== "missing" ? <button type="button" title={item.enabled ? "Disable" : "Enable"} onClick={() => void toggleLocalItem(item)} disabled={busy}>{item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}</button> : null}<button type="button" title="Delete" onClick={() => void removeLocalItem(item)} disabled={busy}><Trash2 size={15} /></button></div></div>) : <span className="muted">Empty — drop files into the folder or install from Content.</span>}</div>; })}</div>}
                {instanceTab === "runtime" && <div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>RAM</h3><span>Allocated memory for this instance only.</span></div></div><label>Allocated RAM<MemorySlider value={selected.maxMemoryMb ?? bootstrap.settings.maxMemoryMb} onChange={(next) => void updateSelected({ maxMemoryMb: next })} /></label><label>Extra JVM flags<textarea value={selected.extraJvmArgs ?? ""} rows={2} spellCheck={false} placeholder={bootstrap.settings.extraJvmArgs || "-XX:+UseG1GC -XX:MaxGCPauseMillis=50"} onChange={(event) => void updateSelected({ extraJvmArgs: event.target.value })} /></label></div>}
                {instanceTab === "content" && <div className={contentExiting ? "settings-content content-content content-exiting" : "settings-content content-content"} key={`${contentType}-${selected.id}`}><div className="surface-heading"><PackageSearch size={19} /><div><h3>Discover {contentLabel(contentType).toLowerCase()}</h3><span>Browse Modrinth for {selected.gameVersion} / {selected.loader}.</span></div></div><nav className="content-types" aria-label="Content type">{contentTypes.map(({ id, label, icon: Icon }) => <button key={id} className={contentType === id ? "content-type active" : "content-type"} onClick={() => switchContentType(id)}><Icon size={15} /><span>{label}</span></button>)}</nav><div className="content-browser"><div className="content-main"><div className="search-row"><input value={modQuery} onChange={(event) => setModQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runContentSearch({ page: 1 }); }} placeholder="Search or leave empty to browse" /><button onClick={() => void runContentSearch({ page: 1 })} disabled={busy}><Search size={16} /> Search</button></div><div className="browse-controls"><label className="sort-label">Sort by:<Dropdown value={sortLabel} options={sortOptions.map((option) => option.label)} ariaLabel="Sort by" onChange={(label) => { const found = sortOptions.find((option) => option.label === label); if (found) void runContentSearch({ page: 1, sort: found.id }); }} /></label><label className="sort-label">View:<Dropdown value={String(contentLimit)} options={["10", "20", "50"]} ariaLabel="Results per page" onChange={(label) => void runContentSearch({ page: 1, limit: Number(label) })} /></label>{totalHits > 0 ? <span className="muted">{totalHits} result{totalHits === 1 ? "" : "s"}</span> : null}</div><div className={busy ? "mod-results refreshing" : "mod-results"}>{visibleResults.map((result) => <article key={`${result.projectType}-${result.id}`} className="mod-card">{result.iconUrl ? <img className="mod-card-icon" src={result.iconUrl} alt="" /> : <div className="mod-card-icon mod-icon">{result.title[0]}</div>}<div className="mod-card-main"><div className="mod-card-title"><strong>{result.title}</strong>{result.author ? <span>by {result.author}</span> : null}</div><p>{result.summary}</p>{result.categories.length ? <div className="mod-card-tags">{result.categories.slice(0, 5).map((category) => <span key={category} className="tag-chip">{category}</span>)}</div> : null}</div><div className="mod-card-side">{installedProjectIds.has(result.id) ? <span className="installed-badge"><Check size={14} /> Installed</span> : <button className="install-button" onClick={() => void installContent(result)} disabled={busy || !isInstallable(result)} title={`${result.projectType === "modpack" ? "Download" : "Install"} ${result.title}`}><Plus size={14} /> Install</button>}<div className="mod-card-stats"><span><Download size={13} /> {formatDownloads(result.downloads)}</span>{typeof result.follows === "number" ? <span><Heart size={13} /> {formatDownloads(result.follows)}</span> : null}</div>{result.dateModified ? <small className="muted"><Clock size={12} /> {formatRelative(result.dateModified)}</small> : null}</div></article>)}</div>{totalPages > 1 ? <nav className="pages" aria-label="Result pages"><button className="page-button" disabled={contentPage <= 1 || busy} aria-label="Previous page" onClick={() => void runContentSearch({ page: contentPage - 1 })}><ChevronLeft size={15} /></button>{pageList(contentPage, totalPages).map((page, index) => page === "gap" ? <span key={`gap-${index}`} className="page-gap">…</span> : <button key={page} className={page === contentPage ? "page-button active" : "page-button"} disabled={busy} onClick={() => void runContentSearch({ page })}>{page}</button>)}<button className="page-button" disabled={contentPage >= totalPages || busy} aria-label="Next page" onClick={() => void runContentSearch({ page: contentPage + 1 })}><ChevronRight size={15} /></button></nav> : null}</div><aside className="content-filters"><div className="filter-row"><div><strong>Hide content already installed</strong></div><button type="button" role="switch" aria-checked={hideInstalled} className="switch" onClick={() => setHideInstalled((value) => !value)}><span className="knob" /></button></div><div className="filter-group"><div className="section-title">Game version</div>{versionUnlocked ? <Dropdown value={versionOverride ?? selected.gameVersion} options={gameVersions ?? [selected.gameVersion]} ariaLabel="Game version filter" onChange={(version) => { setVersionOverride(version); void runContentSearch({ page: 1, versions: [version] }); }} /> : <><span className="filter-lock">{selected.gameVersion}</span><p className="muted">Game version is provided by the instance. Unlocking may show incompatible content.</p><button onClick={() => { setVersionUnlocked(true); setVersionOverride(selected.gameVersion); }}><Lock size={14} /> Unlock filter</button></>}</div>{contentType === "mod" ? <div className="filter-group"><div className="section-title">Loader</div>{loaderUnlocked ? <Dropdown value={loaderOverride ?? selected.loader} options={loaderFilterOptions} ariaLabel="Loader filter" onChange={(loader) => { setLoaderOverride(loader); void runContentSearch({ page: 1, loaders: [loader] }); }} /> : <><span className="filter-lock">{selected.loader}</span><button onClick={() => { setLoaderUnlocked(true); setLoaderOverride(selected.loader === "vanilla" ? "fabric" : selected.loader); }}><Lock size={14} /> Unlock filter</button></>}</div> : null}<div className="filter-group"><div className="section-title">Categories</div><div className="filter-checks">{categoryTags.length ? categoryTags.map((tag) => <label key={tag} className="filter-check"><input type="checkbox" checked={selectedCategories.includes(tag)} onChange={() => toggleCategory(tag)} />{tag}</label>) : <span className="muted">No categories</span>}</div></div></aside></div></div>}
              </section>
            </> : <div className="blank-workspace"><Boxes size={34} /><h2>Select an instance</h2></div>}
          </section>
        </main>
      )}

      {section === "launcher" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">Application</span><h2>Launcher settings</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Settings size={19} /><div><h3>Memory</h3><span>Default allocated RAM for instances.</span></div></div><label>Allocated RAM<MemorySlider value={settingsDraft.maxMemoryMb} onChange={(next) => setSettingsDraft({ ...settingsDraft, maxMemoryMb: next })} /></label><label>Extra JVM flags<textarea value={settingsDraft.extraJvmArgs} rows={2} spellCheck={false} placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" onChange={(event) => setSettingsDraft({ ...settingsDraft, extraJvmArgs: event.target.value })} /></label></div><button className="primary-button save-button" onClick={saveSettings}><Save size={16} /> Save settings</button></section><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>Java installations</h3><span>One runtime per Minecraft requirement. The launcher picks the right one automatically.</span></div></div><div className="java-rows">{javaInstalls ? javaInstalls.map((installation) => <div key={installation.major} className="java-row"><div className="java-row-head"><strong>Java {installation.major} location</strong>{installation.valid ? <CheckCircle2 size={17} className="java-status ok" /> : <XCircle size={17} className="java-status bad" />}</div><input value={installation.path} readOnly placeholder="Not installed" /><div className="java-actions"><button onClick={() => void javaAction(installation.major, "install")} disabled={javaBusy !== null}><Download size={15} /> Install recommended</button><button onClick={() => void javaAction(installation.major, "detect")} disabled={javaBusy !== null}><RefreshCw size={15} /> Detect</button><button onClick={() => void javaAction(installation.major, "browse")} disabled={javaBusy !== null}><FolderOpen size={15} /> Browse</button></div><small className="muted">{javaBusy === installation.major ? "Working..." : installation.message}</small></div>) : <span className="muted">Loading Java installations...</span>}</div></div></section></main>}

      {section === "visuals" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">Appearance</span><h2>Visuals</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Palette size={19} /><div><h3>Theme</h3><span>Pick a parameter, choose any color. Applied instantly.</span></div></div><div className="visuals-layout"><div className="visuals-main"><div className="preset-row">{THEME_PRESETS.map((item) => <button key={item.id} type="button" onClick={() => applyPreset(item.id)}>{item.label}</button>)}</div><div className="theme-grid">{THEME_GROUPS.map((group) => <div key={group} className="theme-group-block anim-stagger"><span className="theme-group">{group}</span>{THEME_TOKENS.filter((token) => token.group === group).map((token) => { const value = theme[token.id] ?? token.default; return <label key={token.id} className="theme-row" onMouseEnter={() => setPreviewToken(token.id)}><input type="color" value={value} onChange={(event) => setToken(token.id, event.target.value)} aria-label={token.label} /><span className="theme-dot" style={{ background: value }} /><span className="theme-name">{token.label}</span><code>{value}</code></label>; })}</div>)}</div></div>{(() => { const def = THEME_TOKENS.find((item) => item.id === previewToken) ?? THEME_TOKENS[0]; return <div className="preview-pane"><span className="eyebrow">Preview</span><strong>{def.label}</strong><ThemePreview id={previewToken} /></div>; })()}</div></div></section><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Sparkles size={19} /><div><h3>Motion</h3><span>Cursor glow and animations.</span></div></div><div className="filter-row"><strong>Cursor glow</strong><button type="button" className="switch" role="switch" aria-checked={glowOn} aria-label="Cursor glow" onClick={() => setGlowEnabled(!glowOn)}><span className="knob" /></button></div><label>Glow size · {glowSize}%<input type="range" min={10} max={220} step={5} value={glowSize} disabled={!glowOn} onChange={(event) => setGlowSizeValue(Number(event.target.value))} aria-label="Glow size" /></label><label>Glow follow speed · {glowSpeed}%<input type="range" min={20} max={150} step={10} value={glowSpeed} disabled={!glowOn} onChange={(event) => setGlowSpeedValue(Number(event.target.value))} aria-label="Glow follow speed" /></label><div className="filter-row"><strong>Animations</strong><button type="button" className="switch" role="switch" aria-checked={animsOn} aria-label="Animations" onClick={() => setAnimsEnabled(!animsOn)}><span className="knob" /></button></div></div></section></main>}

      {section === "skins" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">Identity</span><h2>Skins</h2><span className="status-line">{status}</span></div></header><section className={dropActive ? "settings-surface skins-surface dragging" : "settings-surface skins-surface"} onDragOver={(event) => { event.preventDefault(); setDropActive(true); }} onDragLeave={() => setDropActive(false)} onDrop={dropSkin}><div className="settings-content"><div className="surface-heading"><Shirt size={19} /><div><h3>Skin selector</h3><span>Playing as {activeAccount?.profileName ?? activeAccount?.status}{activeAccount?.kind === "ely" ? ". Ely.by skin below." : activeAccount?.status === "signed-in" ? ". Use uploads to Mojang." : ". Offline profile."}</span></div></div>{(() => { const list = canEditSkins ? (skins ?? []) : []; const preview = list.find((item) => item.id === (selectedSkinId ?? activeSkinId)) ?? list.find((item) => item.id === activeSkinId) ?? list[0] ?? null; const cape = (capes ?? []).find((item) => item.active) ?? null; return <div className="skins-layout"><div className="skin-stage"><SkinViewer3D dataUrl={isElyAccount ? (elySkin?.dataUrl ?? null) : (preview?.dataUrl ?? null)} slim={isElyAccount ? (elySkin?.slim ?? false) : (preview?.slim ?? false)} capeUrl={cape?.url ?? null} /><strong>{isElyAccount ? `${activeAccount?.profileName ?? "Ely"} · Ely.by` : (preview?.name ?? "No skin yet")}</strong><span className="muted">{canEditSkins ? "Drag to rotate · scroll to zoom · drop a PNG anywhere" : "Drag to rotate · scroll to zoom"}</span></div><div className="skins-side"><span className="section-title">Saved skins</span>{skins === null ? <span className="muted">Loading skins...</span> : skins.length ? <div className="skin-grid">{skins.map((skin) => <div key={skin.id} role="button" tabIndex={0} onClick={() => setSelectedSkinId(skin.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedSkinId(skin.id); }} className={skin.id === activeSkinId ? "skin-card active" : skin.id === (selectedSkinId ?? activeSkinId) ? "skin-card selected" : "skin-card"}><SkinPreview dataUrl={skin.dataUrl} slim={skin.slim} /><strong>{skin.name}</strong><div className="button-row skin-arms"><button type="button" className={skin.slim ? "" : "content-type active"} onClick={(event) => { event.stopPropagation(); void setSkinModel(skin.id, false); }} disabled={skinBusy || !canEditSkins}>Wide</button><button type="button" className={skin.slim ? "content-type active" : ""} onClick={(event) => { event.stopPropagation(); void setSkinModel(skin.id, true); }} disabled={skinBusy || !canEditSkins}>Slim</button></div><div className="button-row skin-actions"><button type="button" className={skin.id === activeSkinId ? "primary-button" : ""} onClick={(event) => { event.stopPropagation(); void activateSkin(skin.id, skin.name); }} disabled={skinBusy || !canEditSkins || skin.id === activeSkinId}>{skin.id === activeSkinId ? <><Check size={15} /> Active</> : "Use skin"}</button><button type="button" onClick={(event) => { event.stopPropagation(); void removeSkin(skin.id, skin.name); }} disabled={skinBusy || !canEditSkins} title="Delete skin"><Trash2 size={15} /></button></div></div>)}</div> : canEditSkins ? <span className="muted">No skins yet. Upload a 64x64 PNG texture.</span> : isElyAccount ? (elySkin === undefined ? <span className="muted">Loading Ely.by skin...</span> : elySkin ? <span className="muted">Ely.by skin is shown in the preview.</span> : <span className="muted">No skin on this Ely.by account.</span>) : <span className="muted">Sign in with Microsoft to see your skins.</span>}<div className="button-row"><label className={canEditSkins ? "file-pick" : "file-pick disabled"}><Plus size={16} /> Upload skin<input type="file" accept=".png,image/png" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadSkin(file); }} /></label></div>{canEditSkins ? null : <span className="muted">Skins are locked for offline profiles. Sign in with Microsoft to change them.</span>}<span className="section-title">Cape</span>{capes === null ? <span className="muted">Loading capes...</span> : activeAccount?.status !== "signed-in" ? <span className="muted">Sign in with Microsoft to use capes.</span> : capes.length ? <div className="cape-row"><button type="button" className={capes.some((item) => item.active) ? "cape-pick" : "cape-pick active"} onClick={() => void equipCape(null)} disabled={skinBusy} title="No cape">None</button>{capes.map((item) => <button key={item.id} type="button" className={item.active ? "cape-pick active" : "cape-pick"} onClick={() => void equipCape(item.id)} disabled={skinBusy} title={item.alias}><CapeThumb url={item.url} /></button>)}</div> : <span className="muted">No capes on this account. Custom capes cannot be uploaded to Mojang.</span>}</div></div>; })()}</div></section></main>}

      {section === "accounts" && <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}><header className="workspace-header"><div><span className="eyebrow">Identity</span><h2>Account settings</h2><span className="status-line">{status}</span></div></header><section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><User size={19} /><div><h3>Playing as</h3><span>Click an account to switch, no re-login needed.</span></div></div><div className="account-list">{bootstrap.accounts.map((item) => <div key={item.id} role="button" tabIndex={0} onClick={() => void switchAccount(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void switchAccount(item.id); }} className={item.id === activeAccount?.id ? "account-row active" : "account-row"}>{item.id === activeAccount?.id ? <span className="account-dot on" /> : <span className="account-dot" />}{item.kind === "microsoft" ? <KeyRound size={20} /> : <User size={20} />}<div><strong>{item.profileName ?? item.kind}</strong><span>{item.kind === "microsoft" ? "Minecraft account" : item.kind === "ely" ? "Ely.by" : "Offline"}</span></div><button type="button" title="Remove account" onClick={(event) => { event.stopPropagation(); void removeAccount(item.id, item.profileName ?? item.kind); }} disabled={busy}><Trash2 size={15} /></button></div>)}{bootstrap.accounts.length ? null : <span className="muted">No accounts yet. Add one below.</span>}</div><div className="button-row"><button className="primary-button" onClick={beginLogin} disabled={busy}><Plus size={16} /> Add account</button></div></div><div className="settings-content bordered-top"><div className="surface-heading"><UserRoundCog size={19} /><div><h3>Offline profile</h3><span>No Microsoft account needed.</span></div></div><label>Username<input value={offlineName} maxLength={16} onChange={(event) => setOfflineName(event.target.value)} placeholder="Player" /></label><button onClick={useOfflineProfile} disabled={busy}><User size={16} /> Add offline profile</button></div><div className="settings-content bordered-top"><div className="surface-heading"><KeyRound size={19} /><div><h3>Ely.by account</h3><span>Login, skins and Ely servers.</span></div></div><label>Username or e-mail<input value={elyName} onChange={(event) => setElyName(event.target.value)} placeholder="nickname" /></label><label>Password<input type="password" value={elyPassword} onChange={(event) => setElyPassword(event.target.value)} placeholder="••••••••" /></label><label>2FA token (if enabled)<input value={elyTotp} inputMode="numeric" onChange={(event) => setElyTotp(event.target.value.replace(/[^0-9]/g, ""))} placeholder="123456" /></label><button className="primary-button" onClick={elyLogin} disabled={busy}><KeyRound size={16} /> Add Ely account</button></div><div className="settings-content bordered-top"><div className="readonly-path"><HardDrive size={16} /><span>{bootstrap.storagePath}</span></div></div></section></main>}
      </div>
      {confirmDelete && selected ? <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}><div className="modal-card" role="alertdialog" aria-label="Delete instance" onClick={(event) => event.stopPropagation()}><h3>Delete {selected.name}?</h3><p className="muted">The instance folder and ALL its files — worlds, mods, configs — will be permanently removed. This cannot be undone.</p><div className="button-row modal-actions"><button onClick={() => setConfirmDelete(false)}>Cancel</button><button className="danger-button" onClick={() => { setConfirmDelete(false); void removeSelected(); }} disabled={busy}><Trash2 size={15} /> Delete</button></div></div></div> : null}
    </div>
  );
}
