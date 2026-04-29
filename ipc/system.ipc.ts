import { app, ipcMain } from "electron";

export function registerSystemIpcHandlers() {
  ipcMain.handle("system:info", async () => ({
    success: true,
    data: {
      version: app.getVersion(),
      platform: process.platform,
      offlineCapable: true,
    },
  }));
}
