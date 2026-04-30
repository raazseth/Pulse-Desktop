import { BrowserWindow, desktopCapturer } from "electron";
import { getPreferredDisplaySourceId } from "@/main/displaySourcePreference";

export function applyMediaPermissions(win: BrowserWindow) {
  const { session } = win.webContents;

  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      [
        "display-capture",
        "media",
        "microphone",
        "audioCapture",
        "videoCapture",
        "mediaKeySystem",
      ].includes(permission),
    );
  });

  if (typeof session.setDisplayMediaRequestHandler === "function") {
    session.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        const preferred = getPreferredDisplaySourceId();
        const video =
          (preferred ? sources.find((s) => s.id === preferred) : undefined) ??
          sources.find((s) => s.id.startsWith("screen:")) ??
          sources[0] ??
          null;
        callback({ video, audio: "loopback" });
      } catch {
        callback({});
      }
    });
  }
}
