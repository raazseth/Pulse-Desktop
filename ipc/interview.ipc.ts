import path from "path";
import { BrowserWindow, ipcMain, screen } from "electron";
import { applyMediaPermissions } from "@/utils/mediaPermissions";

let pipWin: BrowserWindow | null = null;

export function registerInterviewIpcHandlers(serverPort: number) {
  const preloadPath = path.join(__dirname, "../preload/preload.js");

  ipcMain.handle("interview:start", async () => {
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.focus();
      return;
    }

    const mainWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!mainWin) return;

    let pipUrl: string;
    try {
      const url = new URL(mainWin.webContents.getURL());
      url.searchParams.set("pip", "1");
      pipUrl = url.toString();
    } catch {
      return;
    }

    const { workArea } = screen.getPrimaryDisplay();

    pipWin = new BrowserWindow({
      width: 400,
      height: 680,
      x: workArea.x + workArea.width - 420,
      y: workArea.y + workArea.height - 700,
      minWidth: 320,
      minHeight: 480,
      alwaysOnTop: true,
      title: "Pulse HUD",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [`--server-port=${serverPort}`],
      },
    });

    applyMediaPermissions(pipWin);

    await pipWin.loadURL(pipUrl);

    pipWin.on("closed", () => {
      pipWin = null;
    });
  });

  ipcMain.handle("interview:stop", () => {
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.close();
    }
    pipWin = null;
  });
}
