import path from "path";
import { app } from "electron";
import { LIVE_PULSE_APP_URL } from "./liveUrls";

export { LIVE_PULSE_APP_URL, LIVE_PULSE_WEB_ORIGINS } from "./liveUrls";

export function getDesktopDataDirectory() {
  return path.join(app.getPath("userData"), "pulse-hud");
}

export function getDesktopExportDirectory() {
  return path.join(getDesktopDataDirectory(), "exports");
}

export function getRendererEntryUrl(): string | null {
  const fromEnv = process.env.ELECTRON_RENDERER_URL?.trim();
  if (fromEnv && (/^dist$/i.test(fromEnv) || /^file$/i.test(fromEnv))) {
    return null;
  }
  if (fromEnv) {
    return fromEnv;
  }
  if (app.isPackaged) {
    return null;
  }
  return LIVE_PULSE_APP_URL;
}

export function getRendererEntryFile() {
  return path.resolve(app.getAppPath(), "../client/dist/index.html");
}
