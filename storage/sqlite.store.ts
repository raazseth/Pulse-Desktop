import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

interface StoredSession {
  id: string;
  context: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface StoredEntry {
  id: string;
  sessionId: string;
  text: string;
  timestamp: string;
  speakerId: string;
}

interface StoredTag {
  id: string;
  sessionId: string;
  transcriptId?: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  metadata: Record<string, string>;
}

interface StoredEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface LoadedSession {
  session: StoredSession;
  transcript: StoredEntry[];
  tags: StoredTag[];
  events: StoredEvent[];
}

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "pulse-hud.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        context    TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text       TEXT NOT NULL,
        timestamp  TEXT NOT NULL,
        speaker_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_tags (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        transcript_id TEXT,
        label         TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        created_by    TEXT,
        metadata      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type       TEXT NOT NULL,
        timestamp  TEXT NOT NULL,
        payload    TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_tags_session       ON session_tags(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_session     ON session_events(session_id);
    `);
  }

  upsertSession(session: StoredSession): void {
    this.db.prepare(`
      INSERT INTO sessions (id, context, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET context = excluded.context, updated_at = excluded.updated_at
    `).run(session.id, JSON.stringify(session.context), session.createdAt, session.updatedAt);
  }

  upsertEntry(entry: StoredEntry): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO transcript_entries (id, session_id, text, timestamp, speaker_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.id, entry.sessionId, entry.text, entry.timestamp, entry.speakerId);
  }

  upsertTag(tag: StoredTag): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO session_tags (id, session_id, transcript_id, label, created_at, created_by, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tag.id, tag.sessionId, tag.transcriptId ?? null, tag.label, tag.createdAt, tag.createdBy ?? null, JSON.stringify(tag.metadata));
  }

  upsertEvent(event: StoredEvent): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO session_events (id, session_id, type, timestamp, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, event.type, event.timestamp, JSON.stringify(event.payload));
  }

  loadAll(): LoadedSession[] {
    type RawSession = { id: string; context: string; created_at: string; updated_at: string };
    type RawEntry  = { id: string; session_id: string; text: string; timestamp: string; speaker_id: string };
    type RawTag    = { id: string; session_id: string; transcript_id: string | null; label: string; created_at: string; created_by: string | null; metadata: string };
    type RawEvent  = { id: string; session_id: string; type: string; timestamp: string; payload: string };

    const sessions = this.db.prepare("SELECT * FROM sessions").all() as RawSession[];

    return sessions.map((s) => {
      const transcript = (this.db.prepare(
        "SELECT * FROM transcript_entries WHERE session_id = ? ORDER BY timestamp",
      ).all(s.id) as RawEntry[]).map((e) => ({
        id: e.id, sessionId: e.session_id, text: e.text, timestamp: e.timestamp, speakerId: e.speaker_id,
      }));

      const tags = (this.db.prepare(
        "SELECT * FROM session_tags WHERE session_id = ? ORDER BY created_at",
      ).all(s.id) as RawTag[]).map((t) => ({
        id: t.id, sessionId: t.session_id, transcriptId: t.transcript_id ?? undefined,
        label: t.label, createdAt: t.created_at, createdBy: t.created_by ?? undefined,
        metadata: JSON.parse(t.metadata) as Record<string, string>,
      }));

      const events = (this.db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp",
      ).all(s.id) as RawEvent[]).map((e) => ({
        id: e.id, sessionId: e.session_id, type: e.type, timestamp: e.timestamp,
        payload: JSON.parse(e.payload) as Record<string, unknown>,
      }));

      return {
        session: { id: s.id, context: JSON.parse(s.context) as Record<string, string>, createdAt: s.created_at, updatedAt: s.updated_at },
        transcript,
        tags,
        events,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
