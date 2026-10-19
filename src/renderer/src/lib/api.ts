export function getLauncherApi() {
  if (!window.launcher) throw new Error("Launcher preload failed to load. Restart the launcher.");
  return window.launcher;
}
