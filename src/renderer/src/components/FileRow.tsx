import { CircleAlert, Download, Eye, EyeOff, Layers3, RefreshCw, Trash2 } from "lucide-react";
import { memo } from "react";
import type { ContentIncompatibility, ContentUpdateInfo, LocalContentItem } from "@shared/types";
import { formatBytes, formatDateTime } from "../lib/format";

export interface FileRowActions {
  toggle(item: LocalContentItem): void;
  remove(item: LocalContentItem): void;
  update(item: LocalContentItem): void;
  versions(item: LocalContentItem): void;
}

const LOADER_TITLES: Record<string, string> = { fabric: "Fabric", forge: "Forge", quilt: "Quilt", neoforge: "NeoForge", vanilla: "Vanilla" };

function loaderTitle(loader: string): string {
  return LOADER_TITLES[loader] ?? loader;
}

function shortList(values: string[], limit: number): string {
  return values.length > limit ? `${values[0]} – ${values[values.length - 1]}` : values.join(", ");
}

function IncompatibleChip({ info, t }: { info: ContentIncompatibility; t: (en: string, ru: string) => string }) {
  const target = [info.gameVersion, info.loader ? loaderTitle(info.loader) : undefined].filter(Boolean).join(" · ");
  const built = [shortList(info.supportedGameVersions, 4), info.supportedLoaders.map(loaderTitle).join(", ")].filter(Boolean).join(" · ");
  return <span className="tag-chip incompatible-chip" title={t(`This mod version is built for: ${built}`, `Эта версия мода рассчитана на: ${built}`)}><CircleAlert size={13} /> {t(`Not for ${target}`, `Не для ${target}`)}</span>;
}

export interface FileRowProps {
  item: LocalContentItem;
  info?: ContentUpdateInfo;
  hasRecord: boolean;
  updating: boolean;
  busy: boolean;
  anyUpdating: boolean;
  lang: "en" | "ru";
  actions: { current: FileRowActions };
}

export const FileRow = memo(function FileRow({ item, info, hasRecord, updating, busy, anyUpdating, lang, actions }: FileRowProps) {
  const t = (en: string, ru: string): string => (lang === "ru" ? ru : en);
  return <div className={item.enabled ? "file-row" : "file-row disabled"}>{item.iconUrl ? <img className="file-icon" src={item.iconUrl} alt="" loading="lazy" decoding="async" /> : <div className="file-icon mod-icon">{(item.displayName[0] ?? "?").toUpperCase()}</div>}<div className="file-main"><strong title={item.displayName}>{item.displayName}</strong><small className="muted" title={item.fileName}>{item.fileName} · {formatBytes(item.size)}{item.modified ? ` · ${formatDateTime(item.modified)}` : ""}</small></div><div className="file-side">{item.duplicateOf ? <span className="tag-chip incompatible-chip" title={t(`Duplicate of ${item.duplicateOf}`, `Дубликат файла ${item.duplicateOf}`)}><CircleAlert size={13} /> {t("Duplicate", "Дубликат")}</span> : null}{item.dependents?.length ? <span className="tag-chip" title={t(`Required by: ${item.dependents.join(", ")}`, `Требуется для: ${item.dependents.join(", ")}`)}>{t(`Used by ${item.dependents.length}`, `Нужен для ${item.dependents.length}`)}</span> : null}{info?.incompatible ? <IncompatibleChip info={info.incompatible} t={t} /> : null}{info?.currentVersionNumber ? <span className="tag-chip version-chip" title={`${t("Installed version", "Установленная версия")}: ${info.currentVersionNumber}`}>{info.currentVersionNumber}</span> : null}{updating ? <span className="muted"><RefreshCw size={14} className="spin" /></span> : info?.latest ? <button type="button" className="install-button update-button" title={t(`Update to ${info.latest.versionNumber}`, `Обновить до ${info.latest.versionNumber}`)} onClick={() => actions.current.update(item)} disabled={busy || anyUpdating}><Download size={14} /> <span className="update-button-label">{info.latest.versionNumber}</span></button> : null}{hasRecord ? <button type="button" title={t("Choose version", "Выбрать версию")} onClick={() => actions.current.versions(item)} disabled={busy || updating}><Layers3 size={15} /></button> : null}{item.source === "modrinth" ? <span className="tag-chip">Modrinth</span> : item.source === "curseforge" ? <span className="tag-chip">CurseForge</span> : item.source === "manual" ? <span className="tag-chip manual">{t("Manual", "Вручную")}</span> : <span className="tag-chip missing">{t("Missing file", "Файл отсутствует")}</span>}{item.enabled ? null : <span className="tag-chip">{t("Off", "Отключено")}</span>}{item.source !== "missing" ? <button type="button" title={item.enabled ? t("Disable", "Выключить") : t("Enable", "Включить")} onClick={() => actions.current.toggle(item)} disabled={busy}>{item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}</button> : null}<button type="button" title={t("Delete", "Удалить")} onClick={() => actions.current.remove(item)} disabled={busy}><Trash2 size={15} /></button></div></div>;
});
