import fs from "fs";
import path from "path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { ExportFormat, ExportService, SessionExportData } from "@/services/export.service";
import { getDesktopExportDirectory } from "@/utils/paths";

export function registerSessionIpcHandlers(exportService: ExportService) {
  ipcMain.handle(
    "session:export",
    async (
      _event,
      payload: { session: SessionExportData; format: ExportFormat } | undefined,
    ) => {
      if (!payload?.session || !payload?.format) {
        return { success: false, error: "Session data and format are required" };
      }

      const exported = exportService.exportSession(payload.session, payload.format);
      const exportDirectory = getDesktopExportDirectory();
      fs.mkdirSync(exportDirectory, { recursive: true });

      const defaultPath = path.join(exportDirectory, exported.filename);
      const browserWindow = BrowserWindow.getFocusedWindow();
      const dialogOptions = { defaultPath };
      const { canceled, filePath } = browserWindow
        ? await dialog.showSaveDialog(browserWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (canceled || !filePath) {
        return { success: false, error: "Export cancelled" };
      }

      fs.writeFileSync(filePath, exported.content, "utf8");
      return { success: true, data: { filePath, mimeType: exported.mimeType } };
    },
  );
}
