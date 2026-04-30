import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import { createEmbeddedServer } from "@/server/embedded";

let server: http.Server;
let port: number;
let agent: ReturnType<typeof request>;

beforeAll(async () => {
  ({ server } = createEmbeddedServer());
  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP port");
  port = (addr as AddressInfo).port;
  agent = request(server);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function expectWsUpgradeFails(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.removeAllListeners();
      ws.close();
      finish(() => reject(new Error("timeout waiting for WS failure")));
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      finish(() => reject(new Error("expected upgrade to fail")));
    });
    ws.once("error", () => {
      clearTimeout(timer);
      finish(() => resolve());
    });
    ws.once("close", () => {
      clearTimeout(timer);
      finish(() => resolve());
    });
  });
}

describe("Embedded WebSocket /ws/transcript", () => {
  it("rejects upgrade without token (connection does not open)", async () => {
    await expectWsUpgradeFails(`ws://127.0.0.1:${port}/ws/transcript`);
  });

  it("rejects upgrade with invalid token", async () => {
    await expectWsUpgradeFails(`ws://127.0.0.1:${port}/ws/transcript?token=invalid`);
  });

  it("opens with valid access token in query", async () => {
    const res = await agent
      .post("/api/v1/auth/register")
      .send({ email: `ws-open-${Date.now()}@example.com`, password: "password123", name: "WS Open" })
      .expect(201);
    const token = res.body.data.tokens.accessToken as string;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/transcript?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("timeout"));
      }, 5000);
      ws.once("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  });
});
