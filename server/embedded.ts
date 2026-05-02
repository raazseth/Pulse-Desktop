import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import http from "http";
import { URL } from "url";
import express, { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { SqliteStore } from "@/storage/sqlite.store";
import { logger } from "@/utils/logger";
import { LIVE_PULSE_WEB_ORIGINS } from "@/utils/liveUrls";
import { desktopTranscriptionService } from "@/server/transcription";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function transcribeOpenAiWhisper(
  bodyBuf: Buffer,
  mimeType: string,
  langQuery: string,
  apiKey: string,
): Promise<string> {
  const form = new FormData();
  const mt = mimeType.split(";")[0].trim() || "audio/webm";
  const isMp4 = mt.includes("mp4");
  const filename = isMp4 ? "chunk.m4a" : "chunk.webm";
  const blob = new Blob([new Uint8Array(bodyBuf)], { type: mt });
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  const short = /^[a-z]{2}/i.exec(String(langQuery).split("-")[0] ?? "")?.[0]?.toLowerCase();
  if (short) form.append("language", short);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body: form,
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(pw, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [salt, hashed] = stored.split(":");
  const hash = (await scryptAsync(pw, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), hash);
}

function generateToken(): string { return crypto.randomBytes(32).toString("hex"); }

const ACCESS_TTL_MS  = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface HudSession {
  id: string;
  context: Record<string, string>;
  title: string;
  facilitator: string;
  audience: string;
  role: string;
  status: "active" | "paused" | "ended";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface TranscriptEntry {
  id: string;
  sessionId: string;
  text: string;
  timestamp: string;
  speakerId: string;
}

interface PromptSuggestion {
  id: string;
  sessionId: string;
  title: string;
  text: string;
  timestamp: string;
  transcriptIds: string[];
}

interface SessionTag {
  id: string;
  sessionId: string;
  transcriptId?: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  metadata: Record<string, string>;
}

interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface SignalCue {
  id: string;
  sessionId: string;
  transcriptId?: string;
  kind: "silence" | "sentiment-shift" | "keyword";
  label: string;
  timestamp: string;
}

interface SessionSnapshot {
  session: HudSession;
  transcriptEntries: TranscriptEntry[];
  tags: SessionTag[];
  notes: [];
  prompts: PromptSuggestion[];
  events: SessionEvent[];
  signals: SignalCue[];
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

interface TokenRecord {
  userId: string;
  expiresAt: string;
}

interface MemStore {
  sessions: Map<string, HudSession>;
  transcript: Map<string, TranscriptEntry[]>;
  prompts: Map<string, PromptSuggestion[]>;
  tags: Map<string, SessionTag[]>;
  events: Map<string, SessionEvent[]>;
  users: Map<string, AuthUser>;
  usersByEmail: Map<string, string>;
  accessTokens: Map<string, TokenRecord>;
  refreshTokens: Map<string, TokenRecord>;
}

function createStore(): MemStore {
  return {
    sessions: new Map(),
    transcript: new Map(),
    prompts: new Map(),
    tags: new Map(),
    events: new Map(),
    users: new Map(),
    usersByEmail: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
  };
}

function ensureSession(
  store: MemStore,
  sessionId: string,
  context: Record<string, string> = {},
  sqlite?: SqliteStore,
  createdBy?: string,
  metadata: Partial<Pick<HudSession, "title" | "facilitator" | "audience" | "role" | "status">> = {},
): HudSession {
  const now = new Date().toISOString();
  const existing = store.sessions.get(sessionId);
  if (existing) {
    const merged = { ...existing.context, ...context };
    const updated = {
      ...existing,
      ...metadata,
      context: merged,
      updatedAt: now,
    };
    store.sessions.set(sessionId, updated);
    sqlite?.upsertSession(updated);
    return updated;
  }
  if (!createdBy) throw new Error("createdBy is required to create a session");
  const session: HudSession = {
    id: sessionId,
    context,
    title: metadata.title ?? "Untitled Session",
    facilitator: metadata.facilitator ?? "",
    audience: metadata.audience ?? "",
    role: metadata.role ?? "",
    status: metadata.status ?? "active",
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  store.sessions.set(sessionId, session);
  sqlite?.upsertSession(session);
  return session;
}

function assertSessionAccess(store: MemStore, userId: string, sessionId: string): HudSession {
  const session = store.sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.createdBy !== userId) throw new Error("Forbidden");
  return session;
}

function getSnapshot(store: MemStore, sessionId: string): SessionSnapshot | null {
  const session = store.sessions.get(sessionId);
  if (!session) return null;
  const transcriptEntries = store.transcript.get(sessionId) ?? [];
  const tags = store.tags.get(sessionId) ?? [];
  const prompts = store.prompts.get(sessionId) ?? [];
  const events = store.events.get(sessionId) ?? [];
  const signals: SignalCue[] = events
    .filter((e) => e.type === "signal:detected")
    .map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      transcriptId: typeof e.payload.transcriptId === "string" ? e.payload.transcriptId : undefined,
      kind: e.payload.kind as SignalCue["kind"],
      label: e.payload.label as string,
      timestamp: e.timestamp,
    }));
  return { session, transcriptEntries, tags, notes: [], prompts, events, signals };
}

function saveEvent(store: MemStore, sessionId: string, type: string, payload: Record<string, unknown>, sqlite?: SqliteStore): SessionEvent {
  const event: SessionEvent = { id: crypto.randomUUID(), sessionId, type, timestamp: new Date().toISOString(), payload };
  const list = store.events.get(sessionId) ?? [];
  list.push(event);
  store.events.set(sessionId, list);
  sqlite?.upsertEvent(event);
  return event;
}

function detectSignals(entry: TranscriptEntry): SignalCue[] {
  const text = entry.text.toLowerCase();
  const signals: SignalCue[] = [];
  if (/\.\.\.|pause|silence/.test(text)) {
    signals.push({ id: crypto.randomUUID(), sessionId: entry.sessionId, transcriptId: entry.id, kind: "silence", label: "Possible pause or silence cue", timestamp: entry.timestamp });
  }
  if (/(frustrated|confused|excited|love|hate|annoyed|happy)/.test(text)) {
    signals.push({ id: crypto.randomUUID(), sessionId: entry.sessionId, transcriptId: entry.id, kind: "sentiment-shift", label: "Possible emotion or sentiment shift", timestamp: entry.timestamp });
  }
  if (/(unexpected|surprising|blocked|issue|problem|pain point)/.test(text)) {
    signals.push({ id: crypto.randomUUID(), sessionId: entry.sessionId, transcriptId: entry.id, kind: "keyword", label: "Unexpected keyword or friction signal", timestamp: entry.timestamp });
  }
  return signals;
}

function buildPrompts(sessionId: string, recent: TranscriptEntry[], context?: Record<string, string>): PromptSuggestion[] {
  const now = new Date().toISOString();
  const audience = context?.role ? ` for the ${context.role} role` : "";
  const seeds = recent.slice(-5);
  const unique = new Map<string, PromptSuggestion>();

  for (const entry of seeds) {
    const title = /why|how|what/i.test(entry.text) ? "Clarify the reasoning"
      : /risk|blocker|issue|concern/i.test(entry.text) ? "Probe the risk"
      : /customer|user|stakeholder/i.test(entry.text) ? "Explore user impact"
      : "Push the answer deeper";
    const trimmed = entry.text.length > 120 ? `${entry.text.slice(0, 117)}...` : entry.text;
    if (!unique.has(title)) {
      unique.set(title, { id: crypto.randomUUID(), sessionId, title, text: `Ask a sharper follow-up${audience}: "${trimmed}"`, timestamp: now, transcriptIds: [entry.id] });
    }
  }

  const fallbacks: PromptSuggestion[] = [
    { id: crypto.randomUUID(), sessionId, title: "Validate with an example", text: "Ask for a concrete example of how the situation was handled.", timestamp: now, transcriptIds: seeds.map((e) => e.id) },
    { id: crypto.randomUUID(), sessionId, title: "Test decision quality", text: "Ask what trade-offs were considered before the decision.", timestamp: now, transcriptIds: seeds.map((e) => e.id) },
    { id: crypto.randomUUID(), sessionId, title: "Check measurable impact", text: "Ask how success was measured after the work shipped.", timestamp: now, transcriptIds: seeds.map((e) => e.id) },
  ];

  for (const f of fallbacks) {
    if (unique.size >= 3) break;
    if (!unique.has(f.title)) unique.set(f.title, f);
  }

  return Array.from(unique.values()).slice(0, 5);
}

function processChunk(
  store: MemStore,
  input: { sessionId: string; userId: string; text: string; speakerId?: string; timestamp?: string; context?: Record<string, string> },
  sqlite?: SqliteStore,
): { entry: TranscriptEntry; prompts: PromptSuggestion[]; signals: SignalCue[] } {
  const existing = store.sessions.get(input.sessionId);
  if (existing && existing.createdBy !== input.userId) {
    throw new Error("Forbidden");
  }
  ensureSession(store, input.sessionId, input.context ?? {}, sqlite, input.userId);

  const text = input.text.trim();
  if (!text) throw new Error("Transcript text is required");

  const entry: TranscriptEntry = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    text,
    timestamp: input.timestamp ?? new Date().toISOString(),
    speakerId: input.speakerId?.trim() || "interviewee",
  };

  const transcriptList = store.transcript.get(input.sessionId) ?? [];
  transcriptList.push(entry);
  store.transcript.set(input.sessionId, transcriptList);
  sqlite?.upsertEntry(entry);
  saveEvent(store, entry.sessionId, "transcript:chunk", { transcriptId: entry.id, speakerId: entry.speakerId }, sqlite);

  const signals = detectSignals(entry);
  for (const s of signals) {
    saveEvent(store, entry.sessionId, "signal:detected", { transcriptId: s.transcriptId, kind: s.kind, label: s.label }, sqlite);
  }

  const recent = transcriptList.slice(-8);
  const session = store.sessions.get(input.sessionId);
  const prompts = buildPrompts(entry.sessionId, recent, session?.context);

  store.prompts.set(input.sessionId, prompts);
  sqlite?.replacePromptsForSession(
    input.sessionId,
    prompts.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      title: p.title,
      text: p.text,
      timestamp: p.timestamp,
      transcriptIds: p.transcriptIds ?? [],
    })),
  );
  saveEvent(store, entry.sessionId, "prompt:update", { count: prompts.length }, sqlite);

  return { entry, prompts, signals };
}

function toCsvRow(values: string[]): string {
  return values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",");
}

function exportToCsv(snap: SessionSnapshot): string {
  return [
    "category,id,sessionId,timestamp,speakerId,text,label,transcriptId,eventType,eventPayload",
    ...snap.transcriptEntries.map((e) => toCsvRow(["transcript", e.id, e.sessionId, e.timestamp, e.speakerId, e.text, "", "", "", ""])),
    ...snap.tags.map((t) => toCsvRow(["tag", t.id, t.sessionId, t.createdAt, "", "", t.label, t.transcriptId ?? "", "", JSON.stringify(t.metadata)])),
    ...snap.events.map((e) => toCsvRow(["event", e.id, e.sessionId, e.timestamp, "", "", "", "", e.type, JSON.stringify(e.payload)])),
    ...snap.prompts.map((p) =>
      toCsvRow([
        "prompt",
        p.id,
        p.sessionId,
        p.timestamp,
        "",
        p.text,
        p.title,
        (p.transcriptIds ?? []).join("|"),
        "",
        "",
      ]),
    ),
  ].join("\n");
}

class ConnectionManager {
  private readonly sessionSockets = new Map<string, Set<WebSocket>>();
  private readonly socketSessions = new Map<WebSocket, Set<string>>();

  subscribe(socket: WebSocket, sessionId: string) {
    const sockets = this.sessionSockets.get(sessionId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.sessionSockets.set(sessionId, sockets);
    const sessions = this.socketSessions.get(socket) ?? new Set<string>();
    sessions.add(sessionId);
    this.socketSessions.set(socket, sessions);
  }

  unsubscribeAll(socket: WebSocket) {
    const sessions = this.socketSessions.get(socket);
    if (!sessions) return;
    for (const id of sessions) {
      const set = this.sessionSockets.get(id);
      if (set) { set.delete(socket); if (set.size === 0) this.sessionSockets.delete(id); }
    }
    this.socketSessions.delete(socket);
  }

  broadcast(sessionId: string, message: unknown) {
    const sockets = this.sessionSockets.get(sessionId);
    if (!sockets?.size) return;
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

export function createEmbeddedServer(
  sqlite?: SqliteStore,
  options?: { captureDir?: string },
): { server: http.Server; wss: WebSocketServer } {
  const captureDir = options?.captureDir;
  const store = createStore();

  if (sqlite) {
    for (const user of sqlite.loadUsers()) {
      store.users.set(user.id, user);
      store.usersByEmail.set(user.email, user.id);
    }
    for (const token of sqlite.loadRefreshTokens()) {
      if (new Date(token.expiresAt) >= new Date()) {
        store.refreshTokens.set(token.token, { userId: token.userId, expiresAt: token.expiresAt });
      } else {
        sqlite.deleteRefreshToken(token.token);
      }
    }
    for (const data of sqlite.loadAll()) {
      if (!data.session.createdBy) continue;
      store.sessions.set(data.session.id, {
        id: data.session.id,
        context: data.session.context,
        title: data.session.title ?? "",
        facilitator: data.session.facilitator ?? "",
        audience: data.session.audience ?? "",
        role: data.session.role ?? "",
        status: (data.session.status === "paused" || data.session.status === "ended" ? data.session.status : "active"),
        createdBy: data.session.createdBy,
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      });
      store.transcript.set(data.session.id, data.transcript);
      store.tags.set(data.session.id, data.tags);
      store.events.set(data.session.id, data.events);
      if (data.prompts.length) {
        store.prompts.set(
          data.session.id,
          data.prompts.map((p) => ({
            id: p.id,
            sessionId: p.sessionId,
            title: p.title,
            text: p.text,
            timestamp: p.timestamp,
            transcriptIds: p.transcriptIds,
          })),
        );
      }
    }
  }

  const authAttempts = new Map<string, { count: number; resetAt: number }>();

  function authLimiter(key: string, maxAttempts = 10, windowMs = 60_000): boolean {
    const now = Date.now();
    const bucket = authAttempts.get(key) ?? { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
    bucket.count++;
    authAttempts.set(key, bucket);
    return bucket.count <= maxAttempts;
  }

  const app = express();
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/v1/hud/audio/transcribe" && req.method === "POST") return next();
    return jsonParser(req, res, next);
  });

  const ALLOWED_ORIGINS = new Set<string>([
    "http://localhost:5173",
    "http://localhost:3000",
    "null",
    ...LIVE_PULSE_WEB_ORIGINS,
  ]);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
  }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  const tokenCleanupInterval = setInterval(() => {
    const now = new Date();
    for (const [t, r] of store.accessTokens) {
      if (new Date(r.expiresAt) < now) store.accessTokens.delete(t);
    }
    for (const [t, r] of store.refreshTokens) {
      if (new Date(r.expiresAt) < now) store.refreshTokens.delete(t);
    }
  }, ACCESS_TTL_MS).unref();

  function issueTokens(userId: string): { accessToken: string; refreshToken: string } {
    const now = Date.now();
    const accessToken = generateToken();
    const refreshToken = generateToken();
    store.accessTokens.set(accessToken, { userId, expiresAt: new Date(now + ACCESS_TTL_MS).toISOString() });
    const refreshRecord = { userId, expiresAt: new Date(now + REFRESH_TTL_MS).toISOString() };
    store.refreshTokens.set(refreshToken, refreshRecord);
    sqlite?.upsertRefreshToken({ token: refreshToken, ...refreshRecord });
    return { accessToken, refreshToken };
  }

  function resolveAccessToken(req: Request): AuthUser | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const record = store.accessTokens.get(header.slice(7));
    if (!record || new Date(record.expiresAt) < new Date()) return null;
    return store.users.get(record.userId) ?? null;
  }

  function authenticate(req: Request, res: Response, next: NextFunction): void {
    const user = resolveAccessToken(req);
    if (!user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    res.locals.user = user;
    next();
  }

  function requireUser(res: Response): AuthUser {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) throw new Error("Authentication required");
    return user;
  }

  app.post(
    "/api/v1/hud/audio/transcribe",
    express.raw({ type: "*/*", limit: "25mb" }),
    (req: Request, res: Response, next: NextFunction) => {
      const user = resolveAccessToken(req);
      if (!user) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      res.locals.user = user;
      next();
    },
    async (req: Request, res: Response) => {
      try {
        const user = requireUser(res);
        const sessionId = String(req.query.sessionId ?? "desktop-mic").trim().slice(0, 200);
        const existing = store.sessions.get(sessionId);
        if (existing && existing.createdBy !== user.id) {
          res.status(403).json({ success: false, message: "Forbidden" });
          return;
        }
        ensureSession(store, sessionId, {}, sqlite, user.id);
        const bodyBuf = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
        if (bodyBuf.length < 32) {
          res.json({ success: true, data: { text: "", savedToDisk: false } });
          return;
        }

        const mimeHint = String(req.query.mime ?? req.headers["content-type"] ?? "audio/webm");
        const langQ = String(req.query.lang ?? "en-US");

        const openAiKey = (process.env.PULSE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
        if (openAiKey) {
          try {
            const text = await transcribeOpenAiWhisper(bodyBuf, mimeHint, langQ, openAiKey);
            res.json({ success: true, data: { text } });
            return;
          } catch (err) {
            logger.error("OpenAI audio transcribe failed", err);
            res.status(502).json({
              success: false,
              message: err instanceof Error ? err.message : "OpenAI transcription failed",
            });
            return;
          }
        }

        try {
          const rawLang = langQ.split("-")[0]?.toLowerCase() ?? "en";
          const lang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : "en";
          const text = await desktopTranscriptionService.transcribe(bodyBuf, lang, mimeHint);
          if (captureDir) {
            const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "desktop-mic";
            const sub = path.join(captureDir, safe);
            fs.mkdirSync(sub, { recursive: true });
            const ext = mimeHint.includes("mp4") ? "m4a" : "webm";
            fs.writeFileSync(path.join(sub, `${Date.now()}.${ext}`), bodyBuf);
          }
          res.json({ success: true, data: { text } });
        } catch (err) {
          logger.error("Local Whisper transcription failed", err);
          res.status(502).json({
            success: false,
            message: err instanceof Error ? err.message : "Local Whisper transcription failed",
          });
        }
      } catch (err) {
        logger.error("POST /hud/audio/transcribe", err);
        res.status(500).json({ success: false, message: "Transcription handler error" });
      }
    },
  );

  app.post("/api/v1/auth/register", async (req: Request, res: Response) => {
    const { email, password, name } = req.body as Record<string, string>;
    if (!email || !password || !name) {
      res.status(400).json({ success: false, message: "email, password, and name are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
      return;
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!EMAIL_RE.test(normalizedEmail)) {
      res.status(400).json({ success: false, message: "Invalid email address" });
      return;
    }
    if (!authLimiter(normalizedEmail)) {
      res.status(429).json({ success: false, message: "Too many attempts. Try again later." });
      return;
    }
    if (store.usersByEmail.has(normalizedEmail)) {
      res.status(409).json({ success: false, message: "Email already registered" });
      return;
    }
    const passwordHash = await hashPassword(password);
    const user: AuthUser = { id: crypto.randomUUID(), email: normalizedEmail, name: name.trim(), passwordHash, createdAt: new Date().toISOString() };
    store.users.set(user.id, user);
    store.usersByEmail.set(user.email, user.id);
    sqlite?.upsertUser(user);
    const tokens = issueTokens(user.id);
    res.status(201).json({ success: true, data: { user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }, tokens } });
  });

  app.post("/api/v1/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body as Record<string, string>;
    if (!email || !password) {
      res.status(400).json({ success: false, message: "email and password are required" });
      return;
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!authLimiter(normalizedEmail)) {
      res.status(429).json({ success: false, message: "Too many attempts. Try again later." });
      return;
    }
    const userId = store.usersByEmail.get(normalizedEmail);
    const record = userId ? store.users.get(userId) : undefined;
    if (!record || !(await verifyPassword(password, record.passwordHash))) {
      res.status(401).json({ success: false, message: "Invalid email or password" });
      return;
    }
    const tokens = issueTokens(record.id);
    res.json({ success: true, data: { user: { id: record.id, email: record.email, name: record.name, createdAt: record.createdAt }, tokens } });
  });

  app.post("/api/v1/auth/refresh", (req: Request, res: Response) => {
    const { refreshToken } = req.body as { refreshToken?: string };
    if (!refreshToken) {
      res.status(400).json({ success: false, message: "refreshToken required" });
      return;
    }
    const record = store.refreshTokens.get(refreshToken);
    if (!record || new Date(record.expiresAt) < new Date()) {
      res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
      return;
    }
    const user = store.users.get(record.userId);
    if (!user) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }
    store.refreshTokens.delete(refreshToken);
    sqlite?.deleteRefreshToken(refreshToken);
    const tokens = issueTokens(user.id);
    res.json({ success: true, data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } } });
  });

  app.delete("/api/v1/auth/logout", (req: Request, res: Response) => {
    const { refreshToken } = req.body as { refreshToken?: string };
    if (refreshToken) {
      store.refreshTokens.delete(refreshToken);
      sqlite?.deleteRefreshToken(refreshToken);
    }
    res.json({ success: true, data: null, message: "Logged out" });
  });

  app.get("/api/v1/auth/me", (req: Request, res: Response) => {
    const user = resolveAccessToken(req);
    if (!user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    res.json({ success: true, data: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } });
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json({ success: true, data: { status: "up", service: "pulse-hud-embedded" } });
  });

  app.use("/api/v1/hud", authenticate);

  app.get("/api/v1/hud/sessions", (_req, res) => {
    const user = requireUser(res);
    const sessions = Array.from(store.sessions.values())
      .filter((session) => session.createdBy === user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
    const summaries = sessions.map((session) => ({
      id: session.id,
      title: session.title || "Untitled Session",
      status: session.status,
      noteCount: 0,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
    const lastActiveSession = summaries.find((session) => session.status === "active") ?? summaries[0] ?? null;
    res.json({
      success: true,
      data: summaries,
      lastActiveSessionId: lastActiveSession?.id ?? null,
      lastActiveSession,
    });
  });

  app.post("/api/v1/hud/sessions", (req, res) => {
    const user = requireUser(res);
    const body = req.body as Partial<Pick<HudSession, "title" | "facilitator" | "audience" | "role">>;
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled Session";
    const session = ensureSession(store, crypto.randomUUID(), {}, sqlite, user.id, {
      title,
      facilitator: body.facilitator ?? "",
      audience: body.audience ?? "",
      role: body.role ?? "",
      status: "active",
    });
    res.status(201).json({
      success: true,
      data: {
        id: session.id,
        title: session.title,
        status: session.status,
        noteCount: 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      message: "Session created",
    });
  });

  app.patch("/api/v1/hud/sessions/:sessionId/status", (req: Request, res: Response) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    const status = (req.body as { status?: string }).status;
    if (status !== "active" && status !== "paused" && status !== "ended") {
      res.status(400).json({ success: false, message: "Invalid status" });
      return;
    }
    try {
      assertSessionAccess(store, user.id, sid);
      const updated = ensureSession(store, sid, {}, sqlite, user.id, { status });
      res.json({ success: true, data: { sessionId: sid, status: updated.status } });
    } catch (err) {
      res.status(err instanceof Error && err.message === "Forbidden" ? 403 : 404).json({ success: false, message: err instanceof Error ? err.message : "Session not found" });
    }
  });

  app.post("/api/v1/hud/sessions/:sessionId/start", (req: Request, res: Response) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    try {
      assertSessionAccess(store, user.id, sid);
      const updated = ensureSession(store, sid, {}, sqlite, user.id, { status: "active" });
      res.json({ success: true, data: { sessionId: sid, status: updated.status } });
    } catch (err) {
      res.status(err instanceof Error && err.message === "Forbidden" ? 403 : 404).json({ success: false, message: err instanceof Error ? err.message : "Session not found" });
    }
  });

  app.post("/api/v1/hud/sessions/:sessionId/stop", (req: Request, res: Response) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    try {
      assertSessionAccess(store, user.id, sid);
      const updated = ensureSession(store, sid, {}, sqlite, user.id, { status: "ended" });
      res.json({ success: true, data: { sessionId: sid, status: updated.status } });
    } catch (err) {
      res.status(err instanceof Error && err.message === "Forbidden" ? 403 : 404).json({ success: false, message: err instanceof Error ? err.message : "Session not found" });
    }
  });

  app.get("/api/v1/hud/sessions/:sessionId", (req, res) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    try {
      assertSessionAccess(store, user.id, sid);
    } catch (err) {
      res.status(err instanceof Error && err.message === "Forbidden" ? 403 : 404).json({ success: false, message: err instanceof Error ? err.message : "Session not found" });
      return;
    }
    const snap = getSnapshot(store, sid);
    res.json({ success: true, data: snap });
  });

  app.post("/api/v1/hud/sessions/:sessionId/transcript", (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(res);
      const sid = String(req.params.sessionId);
      const body = req.body as { text?: string; speakerId?: string; timestamp?: string; context?: Record<string, string> };
      const result = processChunk(store, { sessionId: sid, userId: user.id, text: body.text ?? "", speakerId: body.speakerId, timestamp: body.timestamp, context: body.context }, sqlite);
      res.status(201).json({ success: true, data: result });
    } catch (e) { next(e); }
  });

  app.post("/api/v1/hud/sessions/:sessionId/tags", (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(res);
      const sid = String(req.params.sessionId);
      const { label, transcriptId, createdBy, metadata } = req.body as Record<string, string>;
      if (!label?.trim()) {
        res.status(400).json({ success: false, message: "Tag label required" });
        return;
      }
      const existing = store.sessions.get(sid);
      if (existing && existing.createdBy !== user.id) throw new Error("Forbidden");
      ensureSession(store, sid, {}, sqlite, user.id);
      const tag: SessionTag = {
        id: crypto.randomUUID(), sessionId: sid, transcriptId, label: label.trim(),
        createdAt: new Date().toISOString(), createdBy,
        metadata: typeof metadata === "object" && metadata !== null ? metadata as unknown as Record<string, string> : {},
      };
      const list = store.tags.get(sid) ?? [];
      list.push(tag);
      store.tags.set(sid, list);
      sqlite?.upsertTag(tag);
      saveEvent(store, tag.sessionId, "tag:created", { tagId: tag.id, transcriptId: tag.transcriptId, label: tag.label }, sqlite);
      res.status(201).json({ success: true, data: tag });
    } catch (e) { next(e); }
  });

  app.patch("/api/v1/hud/sessions/:sessionId/context", (req: Request, res: Response) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    const body = req.body as { context?: unknown };
    const context =
      body.context !== null &&
      typeof body.context === "object" &&
      !Array.isArray(body.context)
        ? (body.context as Record<string, string>)
        : {};
    const existing = store.sessions.get(sid);
    if (existing && existing.createdBy !== user.id) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }
    ensureSession(store, sid, context, sqlite, user.id);
    saveEvent(store, sid, "session:context-updated", { context }, sqlite);
    res.json({ success: true, data: getSnapshot(store, sid)! });
  });

  app.get("/api/v1/hud/sessions/:sessionId/export", (req, res) => {
    const user = requireUser(res);
    const sid = String(req.params.sessionId);
    try {
      assertSessionAccess(store, user.id, sid);
    } catch (err) {
      res.status(err instanceof Error && err.message === "Forbidden" ? 403 : 404).json({ success: false, message: err instanceof Error ? err.message : "Session not found" });
      return;
    }
    const snap = getSnapshot(store, sid);
    if (!snap) {
      res.status(404).json({ success: false, message: "Session not found" });
      return;
    }
    const format = String(req.query["format"] ?? "") === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="hud-session-${sid}.csv"`);
      res.send(exportToCsv(snap));
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="hud-session-${sid}.json"`);
      res.send(JSON.stringify(snap, null, 2));
    }
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error("Embedded server error", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : message === "Session not found" ? 404 : 500;
    res.status(status).json({ success: false, message });
  };
  app.use(errorHandler);

  const server = http.createServer(app);
  const manager = new ConnectionManager();
  const wss = new WebSocketServer({ noServer: true });
  const socketUsers = new WeakMap<WebSocket, string>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (url.pathname !== "/ws/transcript") return;

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const record = store.accessTokens.get(token);
    if (!record || new Date(record.expiresAt) < new Date()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      socketUsers.set(ws, record.userId);
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "connection:ready" }));

    socket.on("message", async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid JSON" } }));
        return;
      }

      if (!parsed || typeof parsed !== "object" || !("type" in parsed) || !("payload" in parsed)) {
        socket.send(JSON.stringify({ type: "error", payload: { message: "Message must have type and payload" } }));
        return;
      }

      const msg = parsed as { type: string; payload: Record<string, unknown> };

      try {
        const userId = socketUsers.get(socket);
        if (!userId) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Authentication required" } }));
          return;
        }

        if (msg.type === "session:subscribe") {
          const sessionId = String(msg.payload.sessionId ?? "");
          if (!sessionId || sessionId.length > 200) { socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid sessionId" } })); return; }
          try {
            assertSessionAccess(store, userId, sessionId);
          } catch {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Session not found" } }));
            return;
          }
          manager.subscribe(socket, sessionId);
          const snap = getSnapshot(store, sessionId)!;
          socket.send(JSON.stringify({ type: "session:state", payload: snap }));
          return;
        }

        if (msg.type === "transcript:chunk") {
          const sessionId = String(msg.payload.sessionId ?? "");
          const text = String(msg.payload.text ?? "").trim();
          if (!sessionId || sessionId.length > 200) { socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid sessionId" } })); return; }
          if (!text || text.length > 10_000) { socket.send(JSON.stringify({ type: "error", payload: { message: "text is required and must be ≤10,000 chars" } })); return; }
          const p = { sessionId, userId, text, speakerId: msg.payload.speakerId as string | undefined, timestamp: msg.payload.timestamp as string | undefined, context: msg.payload.context as Record<string, string> | undefined };
          const result = processChunk(store, p, sqlite);
          manager.broadcast(p.sessionId, { type: "transcript:chunk", payload: result.entry });
          manager.broadcast(p.sessionId, { type: "prompt:update", payload: result.prompts });
          if (result.signals.length) manager.broadcast(p.sessionId, { type: "signal:detected", payload: result.signals });
          return;
        }

        if (msg.type === "audio:chunk") {
          const sessionId = String(msg.payload.sessionId ?? "");
          const audioB64 = String(msg.payload.audio ?? "");
          if (!sessionId || sessionId.length > 200) {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid sessionId" } }));
            return;
          }
          try {
            assertSessionAccess(store, userId, sessionId);
          } catch {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Session not found" } }));
            return;
          }
          if (audioB64.length > 2_200_000) {
            socket.send(JSON.stringify({ type: "error", payload: { message: "audio payload too large" } }));
            return;
          }
          let buf: Buffer;
          try {
            buf = Buffer.from(audioB64, "base64");
          } catch {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid base64 audio" } }));
            return;
          }
          if (buf.length < 32) return;

          const mimeHint = String(msg.payload.mimeType ?? "audio/webm");
          const speakerId = String(msg.payload.speakerId ?? "system").trim() || "system";
          const rawLang = String(msg.payload.lang ?? "en").split("-")[0]?.toLowerCase() ?? "en";
          const lang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : "en";

          if (captureDir) {
            const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
            const sub = path.join(captureDir, safe);
            fs.mkdirSync(sub, { recursive: true });
            const ext = mimeHint.includes("mp4") ? "m4a" : "webm";
            fs.writeFileSync(path.join(sub, `ws-${Date.now()}.${ext}`), buf);
          }

          const partialId = crypto.randomUUID();
          manager.broadcast(sessionId, {
            type: "TRANSCRIPT_PARTIAL",
            payload: { id: partialId, sessionId, speakerId },
          });

          let text: string;
          try {
            text = await desktopTranscriptionService.transcribe(buf, lang, mimeHint);
          } catch (err) {
            logger.error("audio:chunk local transcription failed", err);
            manager.broadcast(sessionId, { type: "TRANSCRIPT_PARTIAL_CANCEL", payload: { id: partialId } });
            socket.send(JSON.stringify({ type: "error", payload: { message: "Transcription failed" } }));
            return;
          }

          if (!text) {
            manager.broadcast(sessionId, { type: "TRANSCRIPT_PARTIAL_CANCEL", payload: { id: partialId } });
            return;
          }

          const result = processChunk(store, {
            sessionId,
            userId,
            text,
            speakerId,
            context: msg.payload.context as Record<string, string> | undefined,
          }, sqlite);
          manager.broadcast(sessionId, { type: "TRANSCRIPT_FINAL", payload: { ...result.entry, partialId } });
          manager.broadcast(sessionId, { type: "transcript:chunk", payload: result.entry });
          manager.broadcast(sessionId, { type: "prompt:update", payload: result.prompts });
          if (result.signals.length) {
            manager.broadcast(sessionId, { type: "signal:detected", payload: result.signals });
          }
          return;
        }

        if (msg.type === "tag:create") {
          const sessionId = String(msg.payload.sessionId ?? "");
          const label = String(msg.payload.label ?? "").trim();
          if (!sessionId || sessionId.length > 200) { socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid sessionId" } })); return; }
          if (!label || label.length > 200) { socket.send(JSON.stringify({ type: "error", payload: { message: "label is required and must be ≤200 chars" } })); return; }
          const existing = store.sessions.get(sessionId);
          if (existing && existing.createdBy !== userId) {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Forbidden" } }));
            return;
          }
          ensureSession(store, sessionId, {}, sqlite, userId);
          const tag: SessionTag = { id: crypto.randomUUID(), sessionId, transcriptId: msg.payload.transcriptId as string | undefined, label, createdAt: new Date().toISOString(), createdBy: msg.payload.createdBy as string | undefined, metadata: (msg.payload.metadata as Record<string, string>) ?? {} };
          const list = store.tags.get(sessionId) ?? [];
          list.push(tag);
          store.tags.set(sessionId, list);
          sqlite?.upsertTag(tag);
          saveEvent(store, sessionId, "tag:created", { tagId: tag.id, transcriptId: tag.transcriptId, label: tag.label }, sqlite);
          manager.broadcast(sessionId, { type: "tag:created", payload: tag });
          return;
        }

        if (msg.type === "session:context") {
          const sessionId = String(msg.payload.sessionId ?? "");
          if (!sessionId || sessionId.length > 200) { socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid sessionId" } })); return; }
          const context = (msg.payload.context ?? {}) as Record<string, string>;
          const existing = store.sessions.get(sessionId);
          if (existing && existing.createdBy !== userId) {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Forbidden" } }));
            return;
          }
          ensureSession(store, sessionId, context, sqlite, userId);
          saveEvent(store, sessionId, "session:context-updated", { context }, sqlite);
          const snap = getSnapshot(store, sessionId)!;
          manager.broadcast(sessionId, { type: "session:state", payload: snap });
        }
      } catch (e) {
        socket.send(JSON.stringify({ type: "error", payload: { message: e instanceof Error ? e.message : "Unexpected error" } }));
      }
    });

    socket.on("close", () => manager.unsubscribeAll(socket));
  });

  server.on("close", () => {
    clearInterval(tokenCleanupInterval);
    sqlite?.close();
    logger.info("Embedded HUD server stopped");
  });

  return { server, wss };
}

export function startEmbeddedServer(port: number = 3000, dataDir?: string): { server: http.Server; wss: WebSocketServer } {
  const sqlite = dataDir ? new SqliteStore(dataDir) : undefined;
  const captureDir = dataDir ? path.join(dataDir, "audio-capture") : undefined;
  if (captureDir) fs.mkdirSync(captureDir, { recursive: true });
  const { server, wss } = createEmbeddedServer(sqlite, { captureDir });
  server.once("error", (err) => {
    logger.error(`Embedded HUD failed to bind port ${port}`, err);
  });
  server.listen(port, "127.0.0.1");
  return { server, wss };
}
