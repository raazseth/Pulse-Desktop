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
  listDisplaySources(): Promise<Array<{ id: string; name: string }>> {
    return ipcRenderer.invoke("display:listSources");
  },
  setDisplayCaptureSource(sourceId: string | null) {
    return ipcRenderer.invoke("display:setPreferredSource", sourceId);
  },
  getDisplayCapturePreference(): Promise<string | null> {
    return ipcRenderer.invoke("display:getPreferredSource");
  },
  startInterview() {
    return ipcRenderer.invoke("interview:start");
  },
  stopInterview() {
    return ipcRenderer.invoke("interview:stop");
  },
  transcriptBridgePushState(state: unknown) {
    ipcRenderer.send("transcript-bridge:push", state);
  },
  transcriptBridgeGetSnapshot(): Promise<unknown | null> {
    return ipcRenderer.invoke("transcript-bridge:get-snapshot");
  },
  transcriptBridgeOnState(callback: (state: unknown) => void): () => void {
    const fn = (_event: unknown, payload: unknown) => {
      callback(payload);
    };
    ipcRenderer.on("transcript-bridge:state", fn);
    return () => {
      ipcRenderer.removeListener("transcript-bridge:state", fn);
    };
  },
  transcriptBridgeSendChunk(payload: unknown) {
    ipcRenderer.send("transcript-bridge:send-chunk", payload);
  },
  transcriptBridgeOnSendChunk(callback: (payload: unknown) => void): () => void {
    const fn = (_event: unknown, p: unknown) => {
      callback(p);
    };
    ipcRenderer.on("transcript-bridge:send-chunk", fn);
    return () => {
      ipcRenderer.removeListener("transcript-bridge:send-chunk", fn);
    };
  },
  transcriptBridgeOnPleasePush(callback: () => void): () => void {
    const fn = (_event: unknown) => {
      callback();
    };
    ipcRenderer.on("transcript-bridge:please-push", fn);
    return () => {
      ipcRenderer.removeListener("transcript-bridge:please-push", fn);
    };
  },
});
