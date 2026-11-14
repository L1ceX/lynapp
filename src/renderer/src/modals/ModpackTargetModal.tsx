import { Plus } from "lucide-react";
import { useEffect } from "react";
import { Presence } from "../components/Presence";
import { useApp } from "../state/context";

export function ModpackTargetModal() {
  const { busy, cancelModpackTarget, confirmModpackTarget, modpackTarget, t } = useApp();
  const isOpen = Boolean(modpackTarget);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void cancelModpackTarget();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, cancelModpackTarget]);
  return (
    <Presence>{modpackTarget ? <div className="modal-backdrop" onClick={() => void cancelModpackTarget()}><div className="modal-card" role="alertdialog" aria-label={t("Version mismatch", "Несовпадение версий")} onClick={(event) => event.stopPropagation()}><h3>{t("Install", "Установить")} {modpackTarget.info.packName} {t("into", "в")} {modpackTarget.instanceName}?</h3><p className="muted">{t("Pack wants", "Модпаку требуется")} {modpackTarget.info.packGameVersion} / {modpackTarget.info.packLoader}, {t("instance is", "в инстанции")} {modpackTarget.instanceVersion} / {modpackTarget.instanceLoader}. {t("Files may not work.", "Файлы могут не работать.")}</p><div className="button-row modal-actions"><button type="button" onClick={() => void cancelModpackTarget()} disabled={busy}>{t("Cancel", "Отмена")}</button><button type="button" className="primary-button" onClick={() => void confirmModpackTarget()} disabled={busy}><Plus size={15} /> {t("Install anyway", "Всё равно установить")}</button></div></div></div> : null}</Presence>
  );
}
