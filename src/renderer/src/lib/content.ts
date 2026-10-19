import { Archive, Database, Image, PackageSearch, Sparkles } from "lucide-react";
import type { LocalContentItem, LocalContentKind, ModrinthProjectType, ModSearchResult, ModSortIndex } from "@shared/types";

export const contentTypes = [
  { id: "mod" as const, label: "Mods", labelRu: "Моды", icon: PackageSearch },
  { id: "resourcepack" as const, label: "Resource packs", labelRu: "Ресурспаки", icon: Image },
  { id: "shader" as const, label: "Shaders", labelRu: "Шейдеры", icon: Sparkles },
  { id: "datapack" as const, label: "Data packs", labelRu: "Датапаки", icon: Database },
  { id: "modpack" as const, label: "Modpacks", labelRu: "Модпаки", icon: Archive }
];

export const sortLabelRu: Record<string, string> = {
  Relevance: "По релевантности",
  Downloads: "По числу загрузок",
  Follows: "По числу подписок",
  "Recently updated": "Недавно обновлённые",
  Newest: "Недавно добавленные"
};

export const fileSortLabelRu: Record<string, string> = {
  "Name A–Z": "Имя А–Я",
  "Name Z–A": "Имя Я–А",
  "Largest first": "Сначала большие",
  "Smallest first": "Сначала маленькие",
  "Newest first": "Сначала новые",
  "Oldest first": "Сначала старые"
};

export type ExportEntryKind = "normal" | "cache" | "private";

export const exportCacheNames = new Set([".fabric", ".bobby", ".cache", "cache", "downloads", ".mixin.out", "debug", "crash-reports"]);

export const exportPrivateNames = new Set(["logs", "usercache.json", "usernamecache.json", "command_history.txt"]);

export function exportEntryKind(name: string): ExportEntryKind {
  const lower = name.toLowerCase();
  if (exportPrivateNames.has(lower) || /account|token|secret|password|credential/.test(lower) || /\.log$/.test(lower) || /^(hs_err_pid|replay_pid)/.test(lower)) {
    return "private";
  }
  return exportCacheNames.has(lower) ? "cache" : "normal";
}

export const sortOptions: Array<{ id: ModSortIndex; label: string }> = [
  { id: "relevance", label: "Relevance" },
  { id: "downloads", label: "Downloads" },
  { id: "follows", label: "Follows" },
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" }
];

export const loaderFilterOptions = ["fabric", "forge", "quilt", "neoforge"];

export const fileSortOptions = [
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "size-desc", label: "Largest first" },
  { id: "size-asc", label: "Smallest first" },
  { id: "date-desc", label: "Newest first" },
  { id: "date-asc", label: "Oldest first" }
];

export function filterSortFiles(items: LocalContentItem[], query: string, sort: string): LocalContentItem[] {
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

export const fileGroups: Array<{ id: LocalContentKind; label: string; labelRu: string }> = [
  { id: "mod", label: "Mods", labelRu: "Моды" },
  { id: "resourcepack", label: "Resource packs", labelRu: "Ресурспаки" },
  { id: "shader", label: "Shaders", labelRu: "Шейдеры" },
  { id: "datapack", label: "Data packs", labelRu: "Датапаки" }
];

export function contentLabel(type?: ModrinthProjectType): string {
  return contentTypes.find((item) => item.id === (type ?? "mod"))?.label ?? "Content";
}

export function isInstallable(result: ModSearchResult): boolean {
  return !result.id.includes("error") && !result.categories.includes("error");
}
