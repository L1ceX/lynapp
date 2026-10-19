import { Waypoints } from "lucide-react";
import type { ThemeTokenId } from "@shared/theme";

export function ThemePreview({ id, t }: { id: ThemeTokenId; t: (en: string, ru: string) => string }) {
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
