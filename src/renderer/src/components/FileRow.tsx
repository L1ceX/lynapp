import { Download, Eye, EyeOff, Layers3, RefreshCw, Trash2 } from "lucide-react";
import { memo } from "react";
import type { ContentUpdateInfo, LocalContentItem } from "@shared/types";
import { formatBytes, formatDateTime } from "../lib/format";

export interface FileRowActions {
  toggle(item: LocalContentItem): void;
  remove(item: LocalContentItem): void;
  update(item: LocalContentItem): void;
  versions(item: LocalContentItem): void;
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
  return <div className={item.enabled ? "file-row" : "file-row disabled"}>{item.iconUrl ? <img className="file-icon" src={item.iconUrl} alt="" loading="lazy" decoding="async" /> : <div className="file-icon mod-icon">{item.displayName[0] ?? "?"}</div>}<div className="file-main"><strong>{item.displayName}</strong><small className="muted">{item.fileName} · {formatBytes(item.size)}{item.modified ? ` · ${formatDateTime(item.modified)}` : ""}</small></div><div className="file-side">{info?.currentVersionNumber ? <span className="tag-chip version-chip" title={t("Installed version", "Установленная версия")}>{info.currentVersionNumber}</span> : null}{updating ? <span className="muted"><RefreshCw size={14} className="spin" /></span> : info?.latest ? <button type="button" className="install-button update-button" title={t(`Update to ${info.latest.versionNumber}`, `Обновить до ${info.latest.versionNumber}`)} onClick={() => actions.current.update(item)} disabled={busy || anyUpdating}><Download size={14} /> {info.latest.versionNumber}</button> : null}{hasRecord ? <button type="button" title={t("Choose version", "Выбрать версию")} onClick={() => actions.current.versions(item)} disabled={busy || updating}><Layers3 size={15} /></button> : null}{item.source === "modrinth" ? <span className="tag-chip">Modrinth</span> : item.source === "manual" ? <span className="tag-chip manual">{t("Manual", "Вручную")}</span> : <span className="tag-chip missing">{t("Missing file", "Файл отсутствует")}</span>}{item.enabled ? null : <span className="tag-chip">{t("Off", "Отключено")}</span>}{item.source !== "missing" ? <button type="button" title={item.enabled ? t("Disable", "Выключить") : t("Enable", "Включить")} onClick={() => actions.current.toggle(item)} disabled={busy}>{item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}</button> : null}<button type="button" title={t("Delete", "Удалить")} onClick={() => actions.current.remove(item)} disabled={busy}><Trash2 size={15} /></button></div></div>;
});
