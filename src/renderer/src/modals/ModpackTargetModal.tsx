import { Plus } from "lucide-react";
import { Presence } from "../components/Presence";
import { useApp } from "../state/context";

export function ModpackTargetModal() {
  const { busy, cancelModpackTarget, confirmModpackTarget, modpackTarget, t } = useApp();
  return (
    <Presence>{modpackTarget ? <div className="modal-backdrop" onClick={() => void cancelModpackTarget()}><div className="modal-card" role="alertdialog" aria-label={t("Version mismatch", "Несовпадение версий")} onClick={(event) => event.stopPropagation()}><h3>{t("Install", "Установить")} {modpackTarget.info.packName} {t("into", "в")} {modpackTarget.instanceName}?</h3><p className="muted">{t("Pack wants", "Модпаку требуется")} {modpackTarget.info.packGameVersion} / {modpackTarget.info.packLoader}, {t("instance is", "в инстанции")} {modpackTarget.instanceVersion} / {modpackTarget.instanceLoader}. {t("Files may not work.", "Файлы могут не работать.")}</p><div className="button-row modal-actions"><button onClick={() => void cancelModpackTarget()}>{t("Cancel", "Отмена")}</button><button className="primary-button" onClick={() => void confirmModpackTarget()} disabled={busy}><Plus size={15} /> {t("Install anyway", "Всё равно установить")}</button></div></div></div> : null}</Presence>
  );
}
