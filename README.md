# Pulse HUD — Desktop

This is the Electron wrapper for Pulse HUD. Everything important runs on your machine: a small Express API on localhost, SQLite for persistence, and the React UI in a window. You do not need our cloud server to use the desktop build — it is genuinely offline-first.

## What you are running

Think of it as three layers talking to each other:

- **Main process** — starts the embedded server, owns the window, handles IPC.
- **Embedded server** (`localhost:3000`) — auth, sessions, transcript, tags, WebSocket stream, same ideas as the big server but in-memory + SQLite.
- **Renderer** — the Vite-built client (from `../client`), either loaded from disk or pointed at a dev URL.

Session data lives under your OS user data folder, in `pulse-hud` (see `app.getPath("userData")`). Restarts keep your work.

---

## Before you start

You will need **Node 22** and **npm 10+**. Because we use **better-sqlite3**, installs compile native code:

- **Windows:** Visual Studio Build Tools (C++ workload) so native modules can compile.
- **macOS:** Xcode Command Line Tools.
- **Any OS:** Python 3 on PATH helps the node-gyp toolchain.

If `npm install` complains about compilers, fix the toolchain first — the error messages are usually honest about what is missing.

---

## Local development

**1. Install desktop deps**

From the repo root:

```bash
cd desktop
npm install
```

**2. Build or serve the client**

The shell expects the web app at `../client/dist/` unless you override the URL. Either build once:

```bash
cd ../client
npm install
npm run build
```

Or run Vite on port 5173 and use the local script below.

**3. Launch Electron**

Default dev run points the window at the **hosted** app (sigma on Vercel, with extra origins for previews — see `utils/liveUrls.ts` / preload for CORS). From `desktop/`:

```bash
npm run dev
```

If you already have the client dev server up (`npm run dev` in `client` on `:5173`):

```bash
npm run dev:local
```

That is the path with hot reload.

**4. TypeScript-only then Electron**

```bash
npm run build
npm start
```

Useful when you only changed main/preload/server code and already have a `client/dist` build.

**5. Tests**

```bash
npm test
npm run test:watch
npm run test:check
```

Vitest runs in Node — no display, no Electron window. Fine for CI and quick feedback.

---

## Building and installers

Compile TypeScript into `dist/` (entry: `dist/main/main.js`):

```bash
npm run build
```

Shippable installers (see `config/electron-builder.json`):

```bash
npm run dist
```

You should see artifacts under `release/` — NSIS on Windows, DMG on macOS, AppImage on Linux depending on the host.

`better-sqlite3` must match Electron’s Node ABI; electron-builder normally rebuilds it for you. If something explodes with “native module” or missing headers, try `npx @electron/rebuild -f -w better-sqlite3` before packaging again.

---

## Environment variables

There are no API keys baked into the desktop app — tokens are created locally and data stays local. The knobs that matter in practice:

- **`NODE_ENV`** — `production` tightens logging / DevTools behavior; packaging sets this for you.
- **`ELECTRON_RENDERER_URL`** — only for dev: point at `http://localhost:5173` when you use `dev:local` style workflows.

You do not need a `.env` for a normal install. If you prefer env files locally, use something git-ignored (we ignore `.env.local`):

```env
NODE_ENV=development
ELECTRON_RENDERER_URL=http://localhost:5173
```

---

## Code signing (when you care about distribution)

Unsigned installers run, but Windows and macOS will nag users. For real releases you wire certificates into CI (GitHub Actions secrets). Typical names:

**Windows:** `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD`.

**macOS:** `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, plus Apple ID / app-specific password / team ID for notarization.

If those secrets are missing, CI can still produce installers — they are just not prettily signed. Fine for internal builds.

---

## CI/CD (high level)

Workflow lives at `.github/workflows/desktop.yml` in the repo root.

On pushes to `main` and on PRs you usually get a fast test job (typecheck + vitest on Ubuntu) and parallel desktop builds on Windows, macOS, and Linux: build client, rebuild native bits for Electron, compile TypeScript, run electron-builder, upload installers as artifacts (short retention).

Pushing a version tag like `v1.2.3` can drive a release job that attaches the three platform artifacts to a GitHub Release.

Bump `desktop/package.json`, commit, tag, push:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Adjust the workflow if your branching model differs.

---

## Where things live

```
desktop/
├── main/           # app lifecycle, window, wiring
├── preload/      # contextBridge — small, security-sensitive surface
├── ipc/          # ipcMain handlers (export, etc.)
├── server/       # embedded Express + WebSocket (`embedded.ts`)
├── storage/      # SQLite via better-sqlite3
├── services/     # export helpers (JSON / CSV)
├── utils/        # logging, paths, free port, live URLs
├── config/       # electron-builder config
└── tests/        # vitest — HTTP integration + unit tests, no GUI
```

---

## Scope

This package is intentionally **local**: the embedded server listens on **localhost** and is not meant to be exposed to a LAN or the internet as a public API.

The separate Postgres-backed API in `../server/` is optional — use it when you want a hosted multi-user backend; the desktop app does not depend on it for day-to-day offline use.
