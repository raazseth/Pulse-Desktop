import { describe, it, expect, beforeEach } from "vitest";
import { ExportService } from "@/services/export.service";
import type { SessionExportData } from "@/services/export.service";

function makeSession(overrides: Partial<SessionExportData> = {}): SessionExportData {
  return {
    id: "sess-abc",
    transcript: [
      { id: "e1", text: "Hello from Alice", timestamp: "2024-01-01T00:00:00.000Z", speakerId: "Alice" },
      { id: "e2", text: "Reply from Bob", timestamp: "2024-01-01T00:01:00.000Z", speakerId: "Bob" },
    ],
    tags: [
      { id: "t1", label: "Insight", timestamp: "2024-01-01T00:00:30.000Z" },
      { id: "t2", label: "Risk", transcriptId: "e1", timestamp: "2024-01-01T00:00:45.000Z" },
    ],
    events: [
      { id: "ev1", type: "session:start", timestamp: "2024-01-01T00:00:00.000Z", payload: { initiated: true } },
    ],
    ...overrides,
  };
}

describe("ExportService", () => {
  let svc: ExportService;

  beforeEach(() => {
    svc = new ExportService();
  });

  describe("JSON export", () => {
    it("returns filename as <sessionId>.json", () => {
      const { filename } = svc.exportSession(makeSession(), "json");
      expect(filename).toBe("sess-abc.json");
    });

    it("returns mimeType application/json", () => {
      const { mimeType } = svc.exportSession(makeSession(), "json");
      expect(mimeType).toBe("application/json");
    });

    it("produces valid JSON content", () => {
      const { content } = svc.exportSession(makeSession(), "json");
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it("JSON content includes the session id", () => {
      const { content } = svc.exportSession(makeSession(), "json");
      const parsed = JSON.parse(content) as SessionExportData;
      expect(parsed.id).toBe("sess-abc");
    });

    it("JSON content includes transcript entries", () => {
      const { content } = svc.exportSession(makeSession(), "json");
      const parsed = JSON.parse(content) as SessionExportData;
      expect(parsed.transcript).toHaveLength(2);
      expect(parsed.transcript[0].speakerId).toBe("Alice");
    });

    it("JSON content includes tags", () => {
      const { content } = svc.exportSession(makeSession(), "json");
      const parsed = JSON.parse(content) as SessionExportData;
      expect(parsed.tags).toHaveLength(2);
    });

    it("JSON content includes events", () => {
      const { content } = svc.exportSession(makeSession(), "json");
      const parsed = JSON.parse(content) as SessionExportData;
      expect(parsed.events[0].type).toBe("session:start");
    });
  });

  describe("CSV export", () => {
    it("returns filename as <sessionId>.csv", () => {
      const { filename } = svc.exportSession(makeSession(), "csv");
      expect(filename).toBe("sess-abc.csv");
    });

    it("returns mimeType text/csv", () => {
      const { mimeType } = svc.exportSession(makeSession(), "csv");
      expect(mimeType).toBe("text/csv");
    });

    it("first row is the header", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      const firstRow = content.split("\n")[0];
      expect(firstRow).toContain("category");
      expect(firstRow).toContain("id");
      expect(firstRow).toContain("timestamp");
    });

    it("includes a transcript row for each entry", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      const rows = content.split("\n").filter((r) => r.startsWith('"transcript"'));
      expect(rows).toHaveLength(2);
    });

    it("transcript rows contain the speaker id and text", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      expect(content).toContain("Alice");
      expect(content).toContain("Hello from Alice");
    });

    it("includes a tag row for each tag", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      const rows = content.split("\n").filter((r) => r.startsWith('"tag"'));
      expect(rows).toHaveLength(2);
    });

    it("tag rows contain the label", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      expect(content).toContain("Insight");
      expect(content).toContain("Risk");
    });

    it("includes an event row for each event", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      const rows = content.split("\n").filter((r) => r.startsWith('"event"'));
      expect(rows).toHaveLength(1);
    });

    it("escapes double quotes by doubling them", () => {
      const session = makeSession({
        transcript: [
          { id: "e3", text: 'She said "hello world"', timestamp: "2024-01-01T00:02:00.000Z", speakerId: "Carol" },
        ],
        tags: [],
        events: [],
      });
      const { content } = svc.exportSession(session, "csv");
      expect(content).toContain('She said ""hello world""');
    });

    it("wraps all values in double quotes", () => {
      const { content } = svc.exportSession(makeSession(), "csv");
      const dataRows = content.split("\n").slice(1);
      for (const row of dataRows) {
        if (row.trim()) {
          expect(row.startsWith('"')).toBe(true);
          expect(row.endsWith('"')).toBe(true);
        }
      }
    });

    it("handles a session with no transcript, tags, or events", () => {
      const session = makeSession({ transcript: [], tags: [], events: [] });
      const { content } = svc.exportSession(session, "csv");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(1); // header only
    });
  });
});
