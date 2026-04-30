import path from "path";
import { BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import { applyMediaPermissions } from "@/utils/mediaPermissions";

let pipWin: BrowserWindow | null = null;
let mainBridgeWebContents: WebContents | null = null;
let lastTranscriptBridgeState: unknown = null;

export function setInterviewMainWindow(win: BrowserWindow) {
  mainBridgeWebContents = win.webContents;
}

export function registerInterviewIpcHandlers(serverPort: number) {
  const preloadPath = path.join(__dirname, "../preload/preload.js");

  ipcMain.on("transcript-bridge:push", (event, payload: unknown) => {
    if (!mainBridgeWebContents || event.sender !== mainBridgeWebContents) return;
    lastTranscriptBridgeState = payload;
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.webContents.send("transcript-bridge:state", payload);
    }
  });

  ipcMain.handle("transcript-bridge:get-snapshot", () => lastTranscriptBridgeState);

  ipcMain.on("transcript-bridge:send-chunk", (event, payload: unknown) => {
    if (!pipWin || pipWin.isDestroyed() || !mainBridgeWebContents) return;
    if (event.sender !== pipWin.webContents) return;
    mainBridgeWebContents.send("transcript-bridge:send-chunk", payload);
  });

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
        // Same session as the main window so localStorage (auth + HUD session) is shared — otherwise the HUD asks for login again.
        session: mainWin.webContents.session,
        additionalArguments: [`--server-port=${serverPort}`],
      },
    });

    applyMediaPermissions(pipWin);

    await pipWin.loadURL(pipUrl);

    if (!mainWin.isDestroyed()) {
      mainWin.webContents.send("transcript-bridge:please-push");
    }

    pipWin.on("closed", () => {
      pipWin = null;
      lastTranscriptBridgeState = null;
    });
  });

  ipcMain.handle("interview:stop", () => {
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.close();
    }
    pipWin = null;
    lastTranscriptBridgeState = null;
  });
}
