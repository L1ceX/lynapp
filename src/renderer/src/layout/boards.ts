import type { HomeWidgetLayout, PageBoardId } from "@shared/types";

export interface BoardBlockDef {
  id: string;
  label: string;
  labelRu: string;
  minW: number;
  minH?: number;
  locked?: boolean;
}

export interface PageBoardDef {
  blocks: BoardBlockDef[];
  defaults: HomeWidgetLayout[];
}

export const BOARD_COLS = 12;
export const BOARD_ROW = 4;
export const BOARD_GAP = 16;
export const BLOCK_MIN_PX = 240;

export const PAGE_BOARD_IDS: PageBoardId[] = ["launcher", "visuals", "accounts", "skins", "instGeneral", "instRuntime", "instContent"];

const SECTION_BOARDS: Partial<Record<string, PageBoardId>> = { launcher: "launcher", visuals: "visuals", accounts: "accounts", skins: "skins" };
const TAB_BOARDS: Partial<Record<string, PageBoardId>> = { general: "instGeneral", runtime: "instRuntime", content: "instContent" };

export function boardForView(section: string, instanceTab: string): PageBoardId | null {
  if (section === "instances") return TAB_BOARDS[instanceTab] ?? null;
  return SECTION_BOARDS[section] ?? null;
}

export const PAGE_BOARDS: Record<PageBoardId, PageBoardDef> = {
  launcher: {
    blocks: [
      { id: "language", label: "Language", labelRu: "Язык", minW: 3, locked: true },
      { id: "afterLaunch", label: "After the game starts", labelRu: "После запуска игры", minW: 3 },
      { id: "discord", label: "Discord", labelRu: "Discord", minW: 4 },
      { id: "updates", label: "Updates", labelRu: "Обновления", minW: 4 },
      { id: "content", label: "Mods and dependencies", labelRu: "Моды и зависимости", minW: 4 },
      { id: "versionTypes", label: "Game versions", labelRu: "Версии игры", minW: 4 },
      { id: "memory", label: "Memory", labelRu: "Память", minW: 4 },
      { id: "java", label: "Java installations", labelRu: "Установленные версии Java", minW: 5 }
    ],
    defaults: [
      { i: "language", x: 0, y: 0, w: 6, h: 38 },
      { i: "afterLaunch", x: 0, y: 38, w: 6, h: 48 },
      { i: "discord", x: 0, y: 86, w: 6, h: 66 },
      { i: "updates", x: 0, y: 152, w: 6, h: 52 },
      { i: "content", x: 6, y: 178, w: 6, h: 52 },
      { i: "memory", x: 6, y: 0, w: 6, h: 74 },
      { i: "versionTypes", x: 6, y: 74, w: 6, h: 104 },
      { i: "java", x: 0, y: 230, w: 12, h: 120 }
    ]
  },
  visuals: {
    blocks: [
      { id: "presets", label: "Theme presets", labelRu: "Готовые темы", minW: 3, locked: true },
      { id: "colors", label: "Theme colors", labelRu: "Цвета темы", minW: 4 },
      { id: "preview", label: "Preview", labelRu: "Предпросмотр", minW: 3 },
      { id: "motion", label: "Motion", labelRu: "Анимации", minW: 4 },
      { id: "effects", label: "Additional effects", labelRu: "Дополнительные эффекты", minW: 4 }
    ],
    defaults: [
      { i: "presets", x: 0, y: 0, w: 12, h: 28 },
      { i: "colors", x: 0, y: 28, w: 8, h: 160 },
      { i: "preview", x: 8, y: 28, w: 4, h: 70 },
      { i: "motion", x: 8, y: 98, w: 4, h: 100 },
      { i: "effects", x: 0, y: 200, w: 12, h: 120 }
    ]
  },
  accounts: {
    blocks: [
      { id: "list", label: "Accounts", labelRu: "Учётные записи", minW: 4, locked: true },
      { id: "offline", label: "Offline profile", labelRu: "Офлайн-профиль", minW: 3 },
      { id: "ely", label: "Ely.by account", labelRu: "Учётная запись Ely.by", minW: 3 },
      { id: "storage", label: "Data folder", labelRu: "Папка данных", minW: 3 }
    ],
    defaults: [
      { i: "list", x: 0, y: 0, w: 7, h: 60 },
      { i: "storage", x: 0, y: 60, w: 7, h: 18 },
      { i: "offline", x: 7, y: 0, w: 5, h: 48 },
      { i: "ely", x: 7, y: 48, w: 5, h: 84 }
    ]
  },
  skins: {
    blocks: [
      { id: "viewer", label: "Skin preview", labelRu: "Просмотр скина", minW: 4 },
      { id: "saved", label: "Saved skins", labelRu: "Сохранённые скины", minW: 4, locked: true },
      { id: "cape", label: "Cape", labelRu: "Плащ", minW: 3 }
    ],
    defaults: [
      { i: "viewer", x: 0, y: 0, w: 4, h: 110 },
      { i: "saved", x: 4, y: 0, w: 8, h: 110 },
      { i: "cape", x: 4, y: 110, w: 8, h: 40 }
    ]
  },
  instGeneral: {
    blocks: [
      { id: "identity", label: "Name and folder", labelRu: "Название и папка", minW: 4, locked: true },
      { id: "actions", label: "Actions", labelRu: "Действия", minW: 3 }
    ],
    defaults: [
      { i: "identity", x: 0, y: 0, w: 7, h: 50 },
      { i: "actions", x: 7, y: 0, w: 5, h: 50 }
    ]
  },
  instRuntime: {
    blocks: [
      { id: "memory", label: "Memory", labelRu: "Память", minW: 4, locked: true },
      { id: "jvm", label: "JVM flags", labelRu: "Флаги JVM", minW: 4 }
    ],
    defaults: [
      { i: "memory", x: 0, y: 0, w: 6, h: 44 },
      { i: "jvm", x: 6, y: 0, w: 6, h: 44 }
    ]
  },
  instContent: {
    blocks: [
      { id: "browser", label: "Modrinth catalog", labelRu: "Каталог Modrinth", minW: 6, locked: true },
      { id: "filters", label: "Filters", labelRu: "Фильтры", minW: 3 }
    ],
    defaults: [
      { i: "browser", x: 0, y: 0, w: 9, h: 200 },
      { i: "filters", x: 9, y: 0, w: 3, h: 120 }
    ]
  }
};

export function blockMeta(board: PageBoardId, id: string): BoardBlockDef | undefined {
  return PAGE_BOARDS[board].blocks.find((item) => item.id === id);
}

export function normalizeBoard(blocks: BoardBlockDef[], defaults: HomeWidgetLayout[], cols: number, saved: HomeWidgetLayout[] | undefined): HomeWidgetLayout[] {
  const known = new Map(blocks.map((item) => [item.id, item]));
  const result: HomeWidgetLayout[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(saved) ? saved : defaults) {
    if (!item || typeof item.i !== "string" || !known.has(item.i) || seen.has(item.i)) continue;
    const meta = known.get(item.i);
    const w = Math.min(cols, Math.max(meta?.minW ?? 1, Math.round(Number(item.w) || 0)));
    const h = Math.max(meta?.minH ?? 1, Math.round(Number(item.h) || 0));
    const x = Math.min(cols - w, Math.max(0, Math.round(Number(item.x) || 0)));
    const y = Math.max(0, Math.round(Number(item.y) || 0));
    const hidden = item.hidden === true && !meta?.locked;
    result.push({ i: item.i, x, y, w, h, ...(hidden ? { hidden: true } : {}) });
    seen.add(item.i);
  }
  let bottom = result.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (const fallback of defaults) {
    if (seen.has(fallback.i)) continue;
    result.push({ ...fallback, x: 0, y: bottom });
    bottom += fallback.h;
  }
  return result;
}

export function normalizePageBoard(board: PageBoardId, saved: HomeWidgetLayout[] | undefined): HomeWidgetLayout[] {
  const def = PAGE_BOARDS[board];
  return normalizeBoard(def.blocks, def.defaults, BOARD_COLS, saved);
}

export function samePlacement(a: HomeWidgetLayout[], b: HomeWidgetLayout[], withHeight: boolean): boolean {
  if (a.length !== b.length) return false;
  const key = (item: HomeWidgetLayout) => `${item.i}:${item.x}:${item.y}:${item.w}:${withHeight ? item.h : 0}:${item.hidden ? 1 : 0}`;
  return a.map(key).sort().join("|") === b.map(key).sort().join("|");
}
