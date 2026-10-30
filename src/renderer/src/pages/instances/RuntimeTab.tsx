import { Cpu, Terminal } from "lucide-react";
import { Board } from "../../components/Board";
import { MemorySlider } from "../../components/inputs";
import { useApp } from "../../state/context";

export function RuntimeTab() {
  const { instanceTab, selected } = useApp();
  if (!selected || instanceTab !== "runtime") return null;
  return <RuntimeBoard />;
}

function RuntimeBoard() {
  const { bootstrap, selected, t, updateSelected } = useApp();
  if (!selected) return null;
  const blocks = {
    memory: <div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>RAM</h3><span>{t("Allocated memory for this instance only.", "Объём памяти только для этой инстанции.")}</span></div></div><label>{t("Allocated RAM", "Объём памяти")}<MemorySlider label={t("Allocated RAM", "Объём памяти")} value={selected.maxMemoryMb ?? bootstrap.settings.maxMemoryMb} onChange={(next) => void updateSelected({ maxMemoryMb: next })} /></label></div>,
    jvm: <div className="settings-content"><div className="surface-heading"><Terminal size={19} /><div><h3>{t("JVM flags", "Флаги JVM")}</h3><span>{t("Extra Java arguments for this instance.", "Дополнительные аргументы Java для этой инстанции.")}</span></div></div><label>{t("Extra JVM flags", "Дополнительные флаги JVM")}<textarea value={selected.extraJvmArgs ?? ""} rows={2} spellCheck={false} placeholder={bootstrap.settings.extraJvmArgs || "-XX:+UseG1GC -XX:MaxGCPauseMillis=50"} onChange={(event) => void updateSelected({ extraJvmArgs: event.target.value })} /></label></div>
  };
  return <Board id="instRuntime" blocks={blocks} />;
}
