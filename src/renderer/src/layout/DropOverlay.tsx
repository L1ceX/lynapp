import { Archive } from "lucide-react";
import { useApp } from "../state/context";

export function DropOverlay() {
  const { dragZone, navLayout, t, windowDrag } = useApp();
  const sidebarRight = navLayout.sidebarSide === "right";
  return (
    windowDrag && !dragZone ? <div className="drop-overlay drop-overlay-hint"><div className="drop-overlay-card"><Archive size={28} /><strong>{t("Where to drop", "Куда перетащить")}</strong><span>{t(sidebarRight ? "Modpack (.mrpack or CurseForge .zip) — onto the instance list on the right" : "Modpack (.mrpack or CurseForge .zip) — onto the instance list on the left", sidebarRight ? "Сборка (.mrpack или .zip CurseForge) — на список инстанций справа" : "Сборка (.mrpack или .zip CurseForge) — на список инстанций слева")}</span><span>{t("Mods, resource packs, shaders, data packs — onto the open Files tab", "Моды, ресурспаки, шейдеры, датапаки — на открытую вкладку «Файлы»")}</span></div></div> : null
  );
}
