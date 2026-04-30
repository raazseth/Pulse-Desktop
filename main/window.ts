import path from "path";
import { BrowserWindow } from "electron";
import { applyMediaPermissions } from "@/utils/mediaPermissions";
import { setInterviewMainWindow } from "@/ipc/interview.ipc";
import { getRendererEntryFile, getRendererEntryUrl } from "@/utils/paths";
import { logger } from "@/utils/logger";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function devLoadFailurePage(targetUrl: string, detail: string) {
  const safeUrl = escapeHtml(targetUrl);
  const safeDetail = escapeHtml(detail);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pulse HUD — dev load error</title>
<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0a0f17;color:#e2e8f0;padding:2rem;line-height:1.55;max-width:42rem}
h1{font-size:1.25rem;margin:0 0 1rem}
p{margin:0 0 0.75rem}
code{background:#1e293b;padding:0.15em 0.4em;border-radius:4px;font-size:0.9em}
pre{background:#111827;padding:1rem;border-radius:8px;overflow:auto;margin:1rem 0}</style></head><body>
<h1>Could not load the dev UI</h1>
<p><strong>${safeDetail}</strong></p>
<p>Expected renderer at <code>${safeUrl}</code> (default from <code>desktop/utils/liveUrls.ts</code>, or set <code>ELECTRON_RENDERER_URL</code>).</p>
<p>For local Vite, use <code>npm run dev:local</code> from <code>desktop</code>, or from the repo:</p>
<pre><code>cd client
npm run dev</code></pre>
<p>Then restart this app or use <kbd>Ctrl</kbd>+<kbd>R</kbd> in the window.</p>
</body></html>`;
}

function distMissingPage(filePath: string, detail: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Pulse HUD</title>
<style>body{margin:0;font-family:system-ui;background:#0a0f17;color:#e2e8f0;padding:2rem;line-height:1.5}
code{background:#1e293b;padding:0.15em 0.35em;border-radius:4px}</style></head><body>
<h1>Built UI not found</h1>
<p>${escapeHtml(detail)}</p>
<p>Expected <code>${escapeHtml(filePath)}</code>. Build the client first: <code>cd client &amp;&amp; npm run build</code>.</p>
</body></html>`;
}

export async function createAppWindow(serverPort = 3000) {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#0a0f17",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--server-port=${serverPort}`],
    },
  });

  applyMediaPermissions(window);

  const showWindow = () => {
    if (!window.isDestroyed()) window.show();
  };

  window.once("ready-to-show", showWindow);

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logger.error("Renderer did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  const rendererUrl = getRendererEntryUrl();
  const distFile = getRendererEntryFile();

  try {
    if (rendererUrl) {
      await window.loadURL(rendererUrl);
    } else {
      await window.loadFile(distFile);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to load renderer shell", err);
    try {
      if (rendererUrl) {
        const html = devLoadFailurePage(rendererUrl, msg);
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      } else {
        const html = distMissingPage(distFile, msg);
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      }
    } catch (fallbackErr) {
      logger.error("Failed to load fallback error page", fallbackErr);
    }
    showWindow();
  }

  setInterviewMainWindow(window);

  if (process.env.NODE_ENV !== "production") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
}
