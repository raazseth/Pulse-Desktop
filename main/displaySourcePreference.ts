import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const FILENAME = "display-capture-preference.json";

function preferenceFilePath(): string {
  return path.join(app.getPath("userData"), FILENAME);
}

let preferredDisplaySourceId: string | null = null;
let loadedFromDisk = false;

function readDiskIntoMemory(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = fs.readFileSync(preferenceFilePath(), "utf8");
    const data = JSON.parse(raw) as { sourceId?: unknown };
    const id = typeof data.sourceId === "string" ? data.sourceId.trim() : "";
    preferredDisplaySourceId = id || null;
  } catch {
    preferredDisplaySourceId = null;
  }
}

export function setPreferredDisplaySourceId(id: string | null): void {
  readDiskIntoMemory();
  preferredDisplaySourceId = id?.trim() || null;
  try {
    fs.mkdirSync(path.dirname(preferenceFilePath()), { recursive: true });
    fs.writeFileSync(
      preferenceFilePath(),
      JSON.stringify({ sourceId: preferredDisplaySourceId }),
      "utf8",
    );
  } catch {
    // In-memory preference still applies for this session.
  }
}

export function getPreferredDisplaySourceId(): string | null {
  readDiskIntoMemory();
  return preferredDisplaySourceId;
}
