import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import http from "http";
import type { AddressInfo } from "net";
import { createEmbeddedServer } from "@/server/embedded";
import { SqliteStore } from "@/storage/sqlite.store";

function sqliteNativeLoadable(): boolean {
  try {
    const d = new Database(":memory:");
    d.close();
    return true;
  } catch {
    return false;
  }
}

const describeSqlite = sqliteNativeLoadable() ? describe : describe.skip;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve((addr as AddressInfo).port);
    });
    server.once("error", reject);
  });
}

describeSqlite("Embedded server + SQLite", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  it("reloads transcript, tags, and prompts after server restart", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-emb-sqlite-"));
    const captureDir = path.join(tmpDir, "audio-capture");
    fs.mkdirSync(captureDir, { recursive: true });

    const sqlite1 = new SqliteStore(tmpDir);
    const { server: s1 } = createEmbeddedServer(sqlite1, { captureDir });
    const port1 = await listen(s1);
    const agent1 = request(`http://127.0.0.1:${port1}`);

    const reg1 = await agent1
      .post("/api/v1/auth/register")
      .send({ email: `u1-${Date.now()}@example.com`, password: "password123", name: "U1" })
      .expect(201);
    const auth1 = `Bearer ${reg1.body.data.tokens.accessToken as string}`;

    const sessionId = `persist-${Date.now()}`;
    await agent1
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", auth1)
      .send({
        text: "Tell me about your design goals and trade-offs for the system architecture here.",
      })
      .expect(201);

    await agent1
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", auth1)
      .send({ label: "reload-test" })
      .expect(201);

    const snap1 = await agent1
      .get(`/api/v1/hud/sessions/${sessionId}`)
      .set("Authorization", auth1)
      .expect(200);

    expect(snap1.body.data.transcriptEntries.length).toBeGreaterThanOrEqual(1);
    expect(snap1.body.data.tags.some((t: { label: string }) => t.label === "reload-test")).toBe(true);
    expect(snap1.body.data.prompts.length).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => s1.close((e) => (e ? reject(e) : resolve())));

    const sqlite2 = new SqliteStore(tmpDir);
    const { server: s2 } = createEmbeddedServer(sqlite2, { captureDir });
    const port2 = await listen(s2);
    const agent2 = request(`http://127.0.0.1:${port2}`);

    const reg2 = await agent2
      .post("/api/v1/auth/register")
      .send({ email: `u2-${Date.now()}@example.com`, password: "password123", name: "U2" })
      .expect(201);
    const auth2 = `Bearer ${reg2.body.data.tokens.accessToken as string}`;

    const snap2 = await agent2
      .get(`/api/v1/hud/sessions/${sessionId}`)
      .set("Authorization", auth2)
      .expect(200);

    expect(snap2.body.data.transcriptEntries.length).toBeGreaterThanOrEqual(1);
    expect(snap2.body.data.tags.some((t: { label: string }) => t.label === "reload-test")).toBe(true);
    expect(snap2.body.data.prompts.length).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => s2.close((e) => (e ? reject(e) : resolve())));
  });

  it("POST /hud/audio/transcribe saves raw body when captureDir is configured", async () => {
    const prevOpenai = process.env.OPENAI_API_KEY;
    const prevPulseOpenai = process.env.PULSE_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PULSE_OPENAI_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-emb-transcribe-"));
    const captureDir = path.join(tmpDir, "audio-capture");
    fs.mkdirSync(captureDir, { recursive: true });

    try {
      const sqlite = new SqliteStore(tmpDir);
      const { server } = createEmbeddedServer(sqlite, { captureDir });
      const port = await listen(server);
      const agent = request(`http://127.0.0.1:${port}`);

      const reg = await agent
        .post("/api/v1/auth/register")
        .send({ email: `tr-${Date.now()}@example.com`, password: "password123", name: "Tr" })
        .expect(201);
      const token = reg.body.data.tokens.accessToken as string;

      const sessionId = "disk-save-session";
      const body = Buffer.alloc(64, 7);
      const res = await agent
        .post(`/api/v1/hud/audio/transcribe?sessionId=${encodeURIComponent(sessionId)}&mime=audio/webm`)
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "audio/webm")
        .send(body)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.savedToDisk).toBe(true);

      const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const sub = path.join(captureDir, safe);
      expect(fs.existsSync(sub)).toBe(true);
      const files = fs.readdirSync(sub).filter((f) => f.endsWith(".webm"));
      expect(files.length).toBeGreaterThan(0);

      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    } finally {
      if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
      else delete process.env.OPENAI_API_KEY;
      if (prevPulseOpenai !== undefined) process.env.PULSE_OPENAI_API_KEY = prevPulseOpenai;
      else delete process.env.PULSE_OPENAI_API_KEY;
    }
  });
});
