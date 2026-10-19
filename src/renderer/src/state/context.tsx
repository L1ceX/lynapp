import { createContext, useContext } from "react";
import type { BootstrapState, LauncherSettings } from "@shared/types";
import type { LauncherState } from "./useLauncher";

export type AppState = Omit<LauncherState, "bootstrap" | "settingsDraft"> & { bootstrap: BootstrapState; settingsDraft: LauncherSettings };

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext is missing");
  return value;
}
