import { contextBridge, ipcRenderer } from "electron";
import { ExportFormat, SessionExportData } from "@/services/export.service";

const LIVE_PULSE_APP_URL = "https://pulse-web-sigma.vercel.app";
const LIVE_PULSE_WEB_ORIGINS: readonly string[] = [
  LIVE_PULSE_APP_URL,
  "https://pulse-web-git-main-rajs-projects-ab8ef4bc.vercel.app",
  "https://pulse-8tgnnw7wz-rajs-projects-ab8ef4bc.vercel.app",
];

const portArg = process.argv.find((a) => a.startsWith("--server-port="));
const serverPort = portArg ? parseInt(portArg.split("=")[1], 10) : 3000;

contextBridge.exposeInMainWorld("api", {
  serverPort,
  livePulseWebOrigins: [...LIVE_PULSE_WEB_ORIGINS],
  exportSession(session: SessionExportData, format: ExportFormat) {
    return ipcRenderer.invoke("session:export", { session, format });
  },
  startInterview() {
    return ipcRenderer.invoke("interview:start");
  },
  stopInterview() {
    return ipcRenderer.invoke("interview:stop");
  },
});
