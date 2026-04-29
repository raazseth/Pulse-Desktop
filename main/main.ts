import http from "http";
import { WebSocketServer } from "ws";
import { app, BrowserWindow } from "electron";
import { registerSessionIpcHandlers } from "@/ipc/session.ipc";
import { registerSystemIpcHandlers } from "@/ipc/system.ipc";
import { registerInterviewIpcHandlers } from "@/ipc/interview.ipc";
import { startEmbeddedServer } from "@/server/embedded";
import { ExportService } from "@/services/export.service";
import { logger } from "@/utils/logger";
import { createAppWindow } from "@/main/window";
import { findFreePort } from "@/utils/findFreePort";

export let embeddedPort = 3000;

let embedded: { server: http.Server; wss: WebSocketServer } | undefined;

async function bootstrap() {
  const exportService = new ExportService();

  registerSessionIpcHandlers(exportService);
  registerSystemIpcHandlers();

  embeddedPort = await findFreePort(3000);
  registerInterviewIpcHandlers(embeddedPort);
  embedded = startEmbeddedServer(embeddedPort, app.getPath("userData"));
  logger.info(`Embedded HUD server started on port ${embeddedPort}`);

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
