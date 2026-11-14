import { Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Presence } from "../components/Presence";
import { useApp } from "../state/context";

export function DeleteInstanceModal() {
  const { busy, confirmDelete, removeSelected, selected, setConfirmDelete, t } = useApp();
  const isOpen = Boolean(confirmDelete && selected);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setConfirmDelete(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setConfirmDelete]);
  return (
    <Presence>{confirmDelete && selected ? <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}><div className="modal-card" role="alertdialog" aria-label={t("Delete instance", "Удаление инстанции")} onClick={(event) => event.stopPropagation()}><h3>{t("Delete", "Удалить")} {selected.name}?</h3><p className="muted">{t("The instance folder and ALL its files — worlds, mods, configs — will be permanently removed. This cannot be undone.", "Папка инстанции и все её файлы (миры, моды, конфигурации) будут удалены навсегда.")}</p><div className="button-row modal-actions"><button type="button" onClick={() => setConfirmDelete(false)}>{t("Cancel", "Отмена")}</button><button type="button" className="danger-button" onClick={() => { setConfirmDelete(false); void removeSelected(); }} disabled={busy}><Trash2 size={15} /> {t("Delete", "Удалить")}</button></div></div></div> : null}</Presence>
  );
}
