import { BrowserWindow, desktopCapturer } from "electron";

export function applyMediaPermissions(win: BrowserWindow) {
  const { session } = win.webContents;

  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["display-capture", "media", "audioCapture", "videoCapture", "mediaKeySystem"].includes(permission));
  });

  if (typeof session.setDisplayMediaRequestHandler === "function") {
    session.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        callback({ video: sources[0] ?? null, audio: "loopback" });
      } catch {
        callback({});
      }
    });
  }
}
