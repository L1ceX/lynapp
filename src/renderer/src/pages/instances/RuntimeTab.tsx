import { Cpu } from "lucide-react";
import { MemorySlider } from "../../components/inputs";
import { useApp } from "../../state/context";

export function RuntimeTab() {
  const { bootstrap, instanceTab, selected, t, updateSelected } = useApp();
  if (!selected) return null;
  return (
    instanceTab === "runtime" && <div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>RAM</h3><span>{t("Allocated memory for this instance only.", "Объём памяти только для этой инстанции.")}</span></div></div><label>{t("Allocated RAM", "Объём памяти")}<MemorySlider label={t("Allocated RAM", "Объём памяти")} value={selected.maxMemoryMb ?? bootstrap.settings.maxMemoryMb} onChange={(next) => void updateSelected({ maxMemoryMb: next })} /></label><label>{t("Extra JVM flags", "Дополнительные флаги JVM")}<textarea value={selected.extraJvmArgs ?? ""} rows={2} spellCheck={false} placeholder={bootstrap.settings.extraJvmArgs || "-XX:+UseG1GC -XX:MaxGCPauseMillis=50"} onChange={(event) => void updateSelected({ extraJvmArgs: event.target.value })} /></label></div>
  );
}
