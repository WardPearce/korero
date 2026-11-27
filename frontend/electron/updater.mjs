import { app } from "electron";
import electronUpdater from "electron-updater";

const checkInterval = 6 * 60 * 60 * 1000;

export function startUpdater() {
  if (!app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.on("error", (error) => console.error("Update failed:", error));
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  void check();
  setInterval(check, checkInterval).unref();
}
