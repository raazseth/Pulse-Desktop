import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "http";
import { createEmbeddedServer } from "@/server/embedded";

let server: http.Server;
let agent: ReturnType<typeof request>;

beforeAll(async () => {
  ({ server } = createEmbeddedServer());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  agent = request(server);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/v1/health", () => {
  it("returns 200 with status up", async () => {
    const res = await agent.get("/api/v1/health").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("up");
  });
});

describe("POST /api/v1/auth/register", () => {
  it("creates a user and returns token pair", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: "alice@example.com", password: "password123", name: "Alice" })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe("alice@example.com");
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.tokens.refreshToken).toBeTruthy();
  });

  it("normalizes email to lowercase", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: "Bob@Example.COM", password: "password123", name: "Bob" })
      .expect(201);

    expect(res.body.data.user.email).toBe("bob@example.com");
  });

  it("returns 400 when email is missing", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ password: "password123", name: "No Email" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when password is too short", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: "short@example.com", password: "abc", name: "Short" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when email is malformed", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: "password123", name: "Bad" })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 409 on duplicate email", async () => {
    const payload = { email: `dup-${Date.now()}@example.com`, password: "password123", name: "Dup" };
    await agent.post("/api/v1/auth/register").send(payload).expect(201);

    const res = await agent.post("/api/v1/auth/register").send(payload).expect(409);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/auth/login", () => {
  const email = `login-${Date.now()}@example.com`;
  const password = "securepass1";

  beforeAll(async () => {
    await agent.post("/api/v1/auth/register").send({ email, password, name: "Login User" });
  });

  it("returns tokens with correct credentials", async () => {
    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email, password })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });

  it("returns 401 with wrong password", async () => {
    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email, password: "wrongpassword!" })
      .expect(401);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when fields are missing", async () => {
    const res = await agent.post("/api/v1/auth/login").send({}).expect(400);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/auth/refresh", () => {
  let refreshToken: string;

  beforeAll(async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: `refresh-${Date.now()}@example.com`, password: "password123", name: "Refresh" })
      .expect(201);

    refreshToken = res.body.data.tokens.refreshToken as string;
  });

  it("returns a new access token with a valid refresh token", async () => {
    const res = await agent
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("returns 401 with an invalid refresh token", async () => {
    const res = await agent
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "not-a-real-token" })
      .expect(401);

    expect(res.body.success).toBe(false);
  });

  it("returns 400 when refreshToken is missing", async () => {
    const res = await agent.post("/api/v1/auth/refresh").send({}).expect(400);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/v1/auth/me", () => {
  let accessToken: string;

  beforeAll(async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: `me-${Date.now()}@example.com`, password: "password123", name: "Me Route" })
      .expect(201);
    accessToken = res.body.data.tokens.accessToken as string;
  });

  it("returns the authenticated user with a valid token", async () => {
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBeTruthy();
    expect(res.body.data.createdAt).toBeTruthy();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await agent.get("/api/v1/auth/me").expect(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer totally-fake-token")
      .expect(401);

    expect(res.body.success).toBe(false);
  });
});

describe("DELETE /api/v1/auth/logout", () => {
  it("returns 200 and revokes the refresh token", async () => {
    const reg = await agent
      .post("/api/v1/auth/register")
      .send({ email: `logout-${Date.now()}@example.com`, password: "password123", name: "Logout" })
      .expect(201);

    const { refreshToken } = reg.body.data.tokens as { refreshToken: string };

    const res = await agent
      .delete("/api/v1/auth/logout")
      .send({ refreshToken })
      .expect(200);

    expect(res.body.success).toBe(true);

    const refreshRes = await agent
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);

    expect(refreshRes.body.success).toBe(false);
  });

  it("returns 200 even without a refresh token in the body", async () => {
    const res = await agent.delete("/api/v1/auth/logout").send({}).expect(200);
    expect(res.body.success).toBe(true);
  });
});

describe("HUD session routes", () => {
  const sessionId = `test-session-${Date.now()}`;
  let authHeader: string;

  beforeAll(async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: `hud-${Date.now()}@example.com`, password: "password123", name: "HUD Test User" })
      .expect(201);
    authHeader = `Bearer ${res.body.data.tokens.accessToken as string}`;
  });

  describe("POST /transcript", () => {
    it("creates a transcript entry and returns 201", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .set("Authorization", authHeader)
        .send({ text: "Why did you choose this architecture?", speakerId: "Alice" })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.entry.text).toBe("Why did you choose this architecture?");
      expect(res.body.data.entry.sessionId).toBe(sessionId);
      expect(Array.isArray(res.body.data.prompts)).toBe(true);
      expect(Array.isArray(res.body.data.signals)).toBe(true);
    });

    it("returns 401 without an auth token", async () => {
      await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .send({ text: "Unauthenticated" })
        .expect(401);
    });

    it("defaults speakerId to 'interviewee' when omitted", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .set("Authorization", authHeader)
        .send({ text: "An anonymous utterance" })
        .expect(201);

      expect(res.body.data.entry.speakerId).toBe("interviewee");
    });

    it("detects keyword signals in matching text", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .set("Authorization", authHeader)
        .send({ text: "There is an unexpected blocker and an issue we didn't anticipate" })
        .expect(201);

      expect(res.body.data.signals.length).toBeGreaterThan(0);
      const kinds = (res.body.data.signals as Array<{ kind: string }>).map((s) => s.kind);
      expect(kinds).toContain("keyword");
    });

    it("detects silence signals", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .set("Authorization", authHeader)
        .send({ text: "There was a long pause... then silence" })
        .expect(201);

      const kinds = (res.body.data.signals as Array<{ kind: string }>).map((s) => s.kind);
      expect(kinds).toContain("silence");
    });

    it("returns AI prompts alongside the entry", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
        .set("Authorization", authHeader)
        .send({ text: "How did the team decide on this approach?" })
        .expect(201);

      expect(res.body.data.prompts.length).toBeGreaterThan(0);
    });
  });

  describe("GET /sessions/:sessionId", () => {
    it("returns the session snapshot with transcript entries", async () => {
      const res = await agent
        .get(`/api/v1/hud/sessions/${sessionId}`)
        .set("Authorization", authHeader)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.session.id).toBe(sessionId);
      expect(res.body.data.transcriptEntries.length).toBeGreaterThan(0);
    });

    it("returns an empty snapshot for an unknown sessionId (auto-creates session)", async () => {
      const unknownId = `unknown-${Date.now()}`;
      const res = await agent
        .get(`/api/v1/hud/sessions/${unknownId}`)
        .set("Authorization", authHeader)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.transcriptEntries).toEqual([]);
    });

    it("returns 401 without an auth token", async () => {
      await agent.get(`/api/v1/hud/sessions/${sessionId}`).expect(401);
    });
  });

  describe("POST /tags", () => {
    it("creates a tag and returns 201", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/tags`)
        .set("Authorization", authHeader)
        .send({ label: "Insight" })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.label).toBe("Insight");
      expect(res.body.data.sessionId).toBe(sessionId);
    });

    it("returns 400 when label is missing", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/tags`)
        .set("Authorization", authHeader)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it("returns 400 when label is only whitespace", async () => {
      const res = await agent
        .post(`/api/v1/hud/sessions/${sessionId}/tags`)
        .set("Authorization", authHeader)
        .send({ label: "   " })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it("returns 401 without an auth token", async () => {
      await agent
        .post(`/api/v1/hud/sessions/${sessionId}/tags`)
        .send({ label: "Unauthenticated" })
        .expect(401);
    });
  });

  describe("PATCH /context", () => {
    it("updates session context and reflects it in the snapshot", async () => {
      const res = await agent
        .patch(`/api/v1/hud/sessions/${sessionId}/context`)
        .set("Authorization", authHeader)
        .send({ context: { role: "Product Manager", focus: "UX" } })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.session.context.role).toBe("Product Manager");
      expect(res.body.data.session.context.focus).toBe("UX");
    });

    it("merges context with existing values", async () => {
      await agent
        .patch(`/api/v1/hud/sessions/${sessionId}/context`)
        .set("Authorization", authHeader)
        .send({ context: { extra: "value" } })
        .expect(200);

      const res = await agent
        .get(`/api/v1/hud/sessions/${sessionId}`)
        .set("Authorization", authHeader)
        .expect(200);
      expect(res.body.data.session.context.extra).toBe("value");
    });

    it("returns 401 without an auth token", async () => {
      await agent
        .patch(`/api/v1/hud/sessions/${sessionId}/context`)
        .send({ context: { role: "Anon" } })
        .expect(401);
    });
  });

  describe("GET /export", () => {
    it("returns JSON with correct content-type", async () => {
      const res = await agent
        .get(`/api/v1/hud/sessions/${sessionId}/export?format=json`)
        .set("Authorization", authHeader)
        .expect(200);

      expect(res.headers["content-type"]).toMatch(/application\/json/);
      const body = JSON.parse(res.text) as { session: { id: string }; transcriptEntries: unknown[] };
      expect(body.session.id).toBe(sessionId);
      expect(body.transcriptEntries.length).toBeGreaterThan(0);
    });

    it("returns CSV with correct content-type", async () => {
      const res = await agent
        .get(`/api/v1/hud/sessions/${sessionId}/export?format=csv`)
        .set("Authorization", authHeader)
        .expect(200);

      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text).toContain("category");
      expect(res.text).toContain(sessionId);
    });

    it("returns 404 for an unknown session", async () => {
      const res = await agent
        .get(`/api/v1/hud/sessions/nonexistent-xyz-404/export?format=json`)
        .set("Authorization", authHeader)
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it("returns 401 without an auth token", async () => {
      await agent
        .get(`/api/v1/hud/sessions/${sessionId}/export?format=json`)
        .expect(401);
    });
  });
});
