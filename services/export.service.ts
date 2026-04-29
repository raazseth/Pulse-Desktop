export type ExportFormat = "json" | "csv";

export interface SessionExportEntry {
  id: string;
  text: string;
  timestamp: string;
  speakerId: string;
}

export interface SessionExportTag {
  id: string;
  label: string;
  transcriptId?: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

export interface SessionExportEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionExportData {
  id: string;
  transcript: SessionExportEntry[];
  tags: SessionExportTag[];
  events: SessionExportEvent[];
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}

export class ExportService {
  exportSession(session: SessionExportData, format: ExportFormat) {
    if (format === "json") {
      return {
        filename: `${session.id}.json`,
        mimeType: "application/json",
        content: JSON.stringify(session, null, 2),
      };
    }

    const rows = [
      "category,id,timestamp,speakerId,text,label,transcriptId,eventType,eventPayload",
      ...session.transcript.map((entry) =>
        this.toCsvRow(["transcript", entry.id, entry.timestamp, entry.speakerId, entry.text, "", "", "", ""]),
      ),
      ...session.tags.map((tag) =>
        this.toCsvRow(["tag", tag.id, tag.timestamp, "", "", tag.label, tag.transcriptId ?? "", "", JSON.stringify(tag.metadata ?? {})]),
      ),
      ...session.events.map((event) =>
        this.toCsvRow(["event", event.id, event.timestamp, "", "", "", "", event.type, JSON.stringify(event.payload)]),
      ),
    ];

    return {
      filename: `${session.id}.csv`,
      mimeType: "text/csv",
      content: rows.join("\n"),
    };
  }

  private toCsvRow(values: string[]) {
    return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
  }
}
