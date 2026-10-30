import { GripVertical, Play, Square, X } from "lucide-react";
import { useApp } from "../../state/context";

export function LaunchSlot() {
  const { busy, cancelSelected, dockDrag, isLaunching, isSelectedRunning, launchSelected, layoutEditing, selected, startDock, stopSelected, t } = useApp();
  return (
    <div className={dockDrag?.kind === "launch" ? "launch-slot docking" : "launch-slot"}>
      {layoutEditing && selected ? <button type="button" className="dock-handle launch-dock-handle" onPointerDown={(event) => startDock("launch", event)} title={t("Drag the button to the header, next to the tabs or to the corner", "Перетащите кнопку в шапку, к вкладкам или в угол")} aria-label={t("Move the Launch button", "Переместить кнопку «Запустить»")}><GripVertical size={16} /></button> : null}
      {isLaunching
        ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button>
        : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}
    </div>
  );
}
