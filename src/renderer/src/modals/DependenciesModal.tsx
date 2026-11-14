import { Check, Download, ExternalLink, PackageSearch, X } from "lucide-react";
import { useEffect } from "react";
import { getLauncherApi } from "../lib/api";
import { Presence } from "../components/Presence";
import { useApp } from "../state/context";

export function DependenciesModal() {
  const { busy, confirmDependencyInstall, dependencyPrompt, selected, setDependencyPrompt, setSettingFlag, settingsDraft, t, toggleDependencyCheck } = useApp();
  const isOpen = Boolean(dependencyPrompt && selected);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDependencyPrompt(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setDependencyPrompt]);
  return (
    <Presence>{dependencyPrompt && selected ? (() => {
      const selectedCount = dependencyPrompt.dependencies.filter((d) => !d.installed && d.compatible && !d.distributionBlocked && dependencyPrompt.checked[d.projectId]).length;
      const autoOn = settingsDraft.autoInstallDependencies ?? false;
      return (
        <div className="modal-backdrop" onClick={() => setDependencyPrompt(null)}>
          <div className="modal-card version-modal dep-modal" role="dialog" aria-label={t("Mod dependencies", "Зависимости мода")} onClick={(event) => event.stopPropagation()}>
            <div className="export-head">
              <PackageSearch size={20} />
              <div>
                <h3>{dependencyPrompt.title}</h3>
                <span className="muted">{t(`Dependencies for ${dependencyPrompt.targetVersion.versionNumber}`, `Зависимости для версии ${dependencyPrompt.targetVersion.versionNumber}`)}</span>
              </div>
              <button type="button" className="titlebar-button" onClick={() => setDependencyPrompt(null)} aria-label={t("Close", "Закрыть")}><X size={15} /></button>
            </div>
            <div className="filter-row">
              <strong>{t("Auto-install required dependencies next time", "Автоматически скачивать обязательные зависимости")}</strong>
              <button type="button" className="switch" role="switch" aria-checked={autoOn} aria-label={t("Auto-install required dependencies next time", "Автоматически скачивать обязательные зависимости")} onClick={() => void setSettingFlag("autoInstallDependencies", !autoOn)}><span className="knob" /></button>
            </div>
            <div className="export-rows dep-rows">
              {dependencyPrompt.dependencies.map((dep) => {
                const canSelect = !dep.installed && dep.compatible && !dep.distributionBlocked;
                const checked = dep.installed || Boolean(dependencyPrompt.checked[dep.projectId]);
                return (
                  <div
                    key={`${dep.provider}:${dep.projectId}`}
                    role={canSelect ? "button" : undefined}
                    tabIndex={canSelect ? 0 : undefined}
                    className={checked && !dep.installed ? "export-row dep-row on" : canSelect ? "export-row dep-row" : "export-row dep-row locked"}
                    onClick={() => { if (canSelect) toggleDependencyCheck(dep.projectId); }}
                    onKeyDown={(event) => {
                      if (canSelect && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        toggleDependencyCheck(dep.projectId);
                      }
                    }}
                  >
                    <span className="export-check">{checked ? <Check size={14} /> : null}</span>
                    {dep.iconUrl ? <img className="file-icon" src={dep.iconUrl} alt="" /> : <div className="file-icon mod-icon">{dep.title[0] ?? "?"}</div>}
                    <span className="version-main">
                      <strong>{dep.title}</strong>
                      <small className="muted">{dep.versionNumber ? `${dep.versionNumber} · ` : ""}{dep.summary || (dep.author ? t(`by ${dep.author}`, `автор: ${dep.author}`) : "")}</small>
                    </span>
                    <span className={dep.dependencyType === "required" ? "version-type release" : "version-type beta"}>
                      {dep.dependencyType === "required" ? t("Required", "Обязательная") : t("Optional", "Необязательная")}
                    </span>
                    {dep.installed ? (
                      <span className="installed-badge"><Check size={13} /> {t("Installed", "Установлена")}</span>
                    ) : dep.distributionBlocked ? (
                      <button
                        type="button"
                        className="tag-chip missing clickable"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (dep.websiteUrl) void getLauncherApi().openExternal(dep.websiteUrl);
                        }}
                      >
                        <ExternalLink size={12} /> {t("Website", "На сайте")}
                      </button>
                    ) : !dep.compatible ? (
                      <span className="tag-chip missing">{t("Unavailable", "Недоступна")}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="button-row modal-actions">
              <button type="button" onClick={() => setDependencyPrompt(null)}>{t("Cancel", "Отмена")}</button>
              <button type="button" onClick={() => void confirmDependencyInstall(false)} disabled={busy}>{t("Mod only", "Только мод")}</button>
              <button type="button" className="primary-button" onClick={() => void confirmDependencyInstall(true)} disabled={busy}>
                <Download size={15} /> {selectedCount > 0 ? t(`Install with dependencies (${selectedCount + 1})`, `Установить с зависимостями (${selectedCount + 1})`) : t("Install mod", "Установить мод")}
              </button>
            </div>
          </div>
        </div>
      );
    })() : null}</Presence>
  );
}
