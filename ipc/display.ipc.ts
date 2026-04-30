import { ipcMain, desktopCapturer } from "electron";
import {
  getPreferredDisplaySourceId,
  setPreferredDisplaySourceId,
} from "@/main/displaySourcePreference";

export function registerDisplayIpcHandlers() {
  ipcMain.handle("display:listSources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 150, height: 150 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
    }));
  });

  ipcMain.handle("display:setPreferredSource", async (_event, sourceId: string | null) => {
    setPreferredDisplaySourceId(typeof sourceId === "string" ? sourceId : null);
    return { success: true as const };
  });

  ipcMain.handle("display:getPreferredSource", async () => getPreferredDisplaySourceId());
}
