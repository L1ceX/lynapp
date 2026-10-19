import { RefreshCw } from "lucide-react";
import { Presence } from "./components/Presence";
import { DropOverlay } from "./layout/DropOverlay";
import { IconRail } from "./layout/IconRail";
import { Titlebar } from "./layout/Titlebar";
import { DeleteInstanceModal } from "./modals/DeleteInstanceModal";
import { ExportModal } from "./modals/ExportModal";
import { ModpackTargetModal } from "./modals/ModpackTargetModal";
import { VersionPickerModal } from "./modals/VersionPickerModal";
import { AccountsPage } from "./pages/AccountsPage";
import { HomePage } from "./pages/HomePage";
import { InstancesPage } from "./pages/instances/InstancesPage";
import { LauncherSettingsPage } from "./pages/LauncherSettingsPage";
import { SkinsPage } from "./pages/SkinsPage";
import { VisualsPage } from "./pages/VisualsPage";
import { AppContext } from "./state/context";
import { useLauncher } from "./state/useLauncher";

export function App() {
  const app = useLauncher();
  if (!app.bootstrap || !app.settingsDraft) {
    return <main className="loading-screen"><RefreshCw className="spin" size={24} /><span>{app.status}</span></main>;
  }
  const ctx = { ...app, bootstrap: app.bootstrap, settingsDraft: app.settingsDraft };
  const { renderImportModal } = ctx;
  return (
    <AppContext.Provider value={ctx}>
    <div className="app-shell">
      <DropOverlay />
      <Titlebar />
      <div className="app-body">
      <IconRail />

      <HomePage />

      <InstancesPage />

      <LauncherSettingsPage />

      <VisualsPage />

      <SkinsPage />

      <AccountsPage />
      </div>
      <DeleteInstanceModal />
      <ModpackTargetModal />
      <Presence>{renderImportModal()}</Presence>
      <VersionPickerModal /><ExportModal />
    </div>
    </AppContext.Provider>
  );
}
