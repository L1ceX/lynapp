import { Archive } from "lucide-react";
import { useApp } from "../state/context";

export function DropOverlay() {
  const { dragZone, t, windowDrag } = useApp();
  return (
    windowDrag && !dragZone ? <div className="drop-overlay drop-overlay-hint"><div className="drop-overlay-card"><Archive size={28} /><strong>{t("Where to drop", "Куда перетащить")}</strong><span>{t(".mrpack modpack — onto the instance list on the left", "Модпак .mrpack — на список инстанций слева")}</span><span>{t("Mods, resource packs, shaders, data packs — onto the open Files tab", "Моды, ресурспаки, шейдеры, датапаки — на открытую вкладку «Файлы»")}</span></div></div> : null
  );
}
