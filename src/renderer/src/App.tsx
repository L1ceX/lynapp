import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Presence } from "./components/Presence";
import { DockOverlay } from "./layout/DockOverlay";
import { DropOverlay } from "./layout/DropOverlay";
import { IconRail } from "./layout/IconRail";
import { LayoutToolbar } from "./layout/LayoutToolbar";
import { Titlebar } from "./layout/Titlebar";
import { DeleteInstanceModal } from "./modals/DeleteInstanceModal";
import { DependenciesModal } from "./modals/DependenciesModal";
import { ExportModal } from "./modals/ExportModal";
import { ModDetailsModal } from "./modals/ModDetailsModal";
import { ModpackTargetModal } from "./modals/ModpackTargetModal";
import { VersionPickerModal } from "./modals/VersionPickerModal";
import { AccountsPage } from "./pages/AccountsPage";
import { HomePage } from "./pages/HomePage";
import { InstancesPage } from "./pages/instances/InstancesPage";
import { LauncherSettingsPage } from "./pages/LauncherSettingsPage";
import { SkinsPage } from "./pages/SkinsPage";
import { VisualsPage } from "./pages/VisualsPage";
import { AppContext, useApp } from "./state/context";
import { useLauncher } from "./state/useLauncher";

function GlobalShortcuts() {
  const { exitLayoutEditing, layoutEditing, navLayout, startLayoutEditing, switchSection } = useApp();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      const hasModal = Boolean(document.querySelector(".modal-backdrop"));
      if (event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.key >= "1" && event.key <= "6" && !hasModal) {
          const idx = Number(event.key) - 1;
          const next = navLayout.rail[idx];
          if (next) {
            event.preventDefault();
            switchSection(next);
          }
          return;
        }
        if (event.code === "KeyK" && !hasModal) {
          const input = document.querySelector<HTMLInputElement>('[data-quick-search="content"], [data-quick-search="files"], [data-quick-search="sidebar"]');
          if (input) {
            event.preventDefault();
            input.focus();
            input.select();
          }
          return;
        }
        if (event.code === "KeyE" && !inField && !hasModal) {
          event.preventDefault();
          if (layoutEditing) exitLayoutEditing();
          else startLayoutEditing();
          return;
        }
      }
      if (event.key === "Escape" && layoutEditing && !hasModal && !inField) {
        event.preventDefault();
        exitLayoutEditing();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitLayoutEditing, layoutEditing, navLayout.rail, startLayoutEditing, switchSection]);
  return null;
}

export function App() {
  const app = useLauncher();
  if (!app.bootstrap || !app.settingsDraft) {
    return <main className="loading-screen"><RefreshCw className="spin" size={24} /><span>{app.status}</span></main>;
  }
  const ctx = { ...app, bootstrap: app.bootstrap, settingsDraft: app.settingsDraft };
  const { navLayout, renderImportModal } = ctx;
  return (
    <AppContext.Provider value={ctx}>
    <GlobalShortcuts />
    <div className="app-shell">
      <DropOverlay />
      <Titlebar />
      <div className={`app-body dock-${navLayout.railSide}`}>
      <IconRail />

      <HomePage />

      <InstancesPage />

      <LauncherSettingsPage />

      <VisualsPage />

      <SkinsPage />

      <AccountsPage />
      </div>
      <DeleteInstanceModal />
      <LayoutToolbar />
      <DockOverlay />
      <Presence>{renderImportModal()}</Presence>
      <ModDetailsModal /><ModpackTargetModal /><VersionPickerModal /><DependenciesModal /><ExportModal />
    </div>
    </AppContext.Provider>
  );
}
