import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import { app, BrowserWindow, dialog } from "electron";
import { registerSessionIpcHandlers } from "@/ipc/session.ipc";
import { registerSystemIpcHandlers } from "@/ipc/system.ipc";
import { registerInterviewIpcHandlers } from "@/ipc/interview.ipc";
import { registerDisplayIpcHandlers } from "@/ipc/display.ipc";
import { startEmbeddedServer } from "@/server/embedded";
import { desktopTranscriptionService } from "@/server/transcription";
import { ExportService } from "@/services/export.service";
import { logger } from "@/utils/logger";
import { createAppWindow } from "@/main/window";
import { findFreePort } from "@/utils/findFreePort";

export let embeddedPort = 3000;

function appendRecoveryLog(line: string) {
  try {
    const dir = app.getPath("userData");
    fs.appendFileSync(path.join(dir, "session-recovery.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
  }
}

process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", err);
  appendRecoveryLog(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  try {
    dialog.showErrorBox("Pulse HUD — unexpected error", err instanceof Error ? err.message : String(err));
  } catch {
  }
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", reason);
  appendRecoveryLog(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

let embedded: { server: http.Server; wss: WebSocketServer } | undefined;

async function bootstrap() {
  const exportService = new ExportService();

  registerSessionIpcHandlers(exportService);
  registerSystemIpcHandlers();
  registerDisplayIpcHandlers();

  embeddedPort = await findFreePort(3000);
  registerInterviewIpcHandlers(embeddedPort);
  const userData = app.getPath("userData");
  desktopTranscriptionService.setModelsDir(require("path").join(userData, "whisper-models"));
  embedded = startEmbeddedServer(embeddedPort, userData);
  logger.info(`Embedded HUD server started on port ${embeddedPort}`);
  void desktopTranscriptionService.warmup();

  await createAppWindow(embeddedPort);
}

app.whenReady().then(() => {
  bootstrap().catch((error) => {
    logger.error("Failed to start desktop app", error);
    app.quit();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createAppWindow(embeddedPort);
    }
  });
});

app.on("before-quit", () => {
  if (embedded) {
    for (const client of embedded.wss.clients) {
      client.close(1001, "Server shutting down");
    }
    embedded.wss.close();
    embedded.server.close();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
