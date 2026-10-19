import type { EffectsSettings, ExternalImportProgress, ExternalImportResult, ExternalLauncher, ExternalLauncherId, GameVersionType, ModLoader } from "@shared/types";

export type AppSection = "home" | "instances" | "launcher" | "visuals" | "skins" | "accounts";

export type InstanceTab = "general" | "versions" | "content" | "files" | "runtime" | "logs";

export const loaders: ModLoader[] = ["vanilla", "fabric", "forge", "quilt", "neoforge"];

export const defaultCreateForm = { name: "New Instance", gameVersion: "", loader: "" as ModLoader | "", loaderVersion: "" };

export const NONE_OPTION = "—";

export const VERSION_TYPE_ROWS: Array<{ id: GameVersionType; label: string; labelRu: string; hint: string; hintRu: string }> = [
  { id: "release", label: "Releases", labelRu: "Релизы", hint: "Stable versions of the game", hintRu: "Стабильные версии игры" },
  { id: "snapshot", label: "Snapshots", labelRu: "Снапшоты", hint: "Test builds of upcoming versions, including April Fools releases", hintRu: "Тестовые сборки будущих версий, включая первоапрельские" },
  { id: "beta", label: "Beta", labelRu: "Бета", hint: "Beta versions from 2010 and 2011", hintRu: "Бета-версии 2010–2011 годов" },
  { id: "alpha", label: "Alpha and earlier", labelRu: "Альфа и раньше", hint: "The earliest versions: pre-classic, classic, indev, infdev and alpha", hintRu: "Самые ранние версии: pre-classic, classic, indev, infdev и альфа" }
];

export const effectGroups: Array<{ id: Exclude<keyof EffectsSettings, "enabled">; cls: string; label: string; labelRu: string; hint: string; hintRu: string }> = [
  { id: "background", cls: "fx-bg", label: "Animated background", labelRu: "Анимированный фон", hint: "Slowly moving color spots behind the pages", hintRu: "Плавно движущиеся цветовые пятна на фоне страниц" },
  { id: "springs", cls: "fx-springs", label: "Control animations", labelRu: "Анимация элементов управления", hint: "Response of buttons, tabs, menus and dialogs to hover and click", hintRu: "Отклик кнопок, вкладок, меню и диалогов на наведение и нажатие" },
  { id: "launch", cls: "fx-launch", label: "Launch button animation", labelRu: "Анимация кнопки «Запустить»", hint: "Animated gradient and an indicator while the game is running", hintRu: "Анимированный градиент и индикатор работы игры" },
  { id: "cascade", cls: "fx-cascade", label: "Appearance animation", labelRu: "Анимация появления", hint: "Pages fade in, list items appear in sequence", hintRu: "Плавное появление страниц и поочерёдное появление элементов списков" },
  { id: "cards", cls: "fx-cards", label: "Card animations", labelRu: "Анимация карточек", hint: "Cards and icons react to the cursor", hintRu: "Карточки и иконки реагируют на наведение курсора" },
  { id: "details", cls: "fx-details", label: "Status indicators", labelRu: "Индикаторы состояния", hint: "Animated progress bars, account status, crash notice and empty states", hintRu: "Анимация полос загрузки, статуса аккаунта, уведомления о сбое и пустых состояний" }
];

export const EXTERNAL_LAUNCHERS: Record<ExternalLauncherId, { label: string; labelRu: string; color: string }> = {
  modrinth: { label: "Modrinth App", labelRu: "Modrinth App", color: "#1bd96a" },
  prism: { label: "Prism Launcher", labelRu: "Prism Launcher", color: "#a78bfa" },
  polymc: { label: "PolyMC", labelRu: "PolyMC", color: "#8bc34a" },
  multimc: { label: "MultiMC", labelRu: "MultiMC", color: "#90a4ae" },
  curseforge: { label: "CurseForge", labelRu: "CurseForge", color: "#f16436" },
  minecraft: { label: "Official launcher / TLauncher", labelRu: "Официальный лаунчер / TLauncher", color: "#62b34a" }
};

export const LOADER_NAMES: Record<string, string> = { vanilla: "Vanilla", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt" };

export interface ImportModalState {
  launchers: ExternalLauncher[] | null;
  active: string | null;
  extraRoots: string[];
  picking?: boolean;
  checked: Record<string, boolean>;
  running: boolean;
  progress: Record<string, ExternalImportProgress>;
  result: ExternalImportResult | null;
  error?: string;
}
