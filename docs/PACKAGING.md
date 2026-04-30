# Desktop packaging: signing, notarization, smoke tests

## macOS (DMG)

1. **Apple Developer**: Team ID, "Developer ID Application" certificate installed in Keychain.
2. **Entitlements**: `config/entitlements.mac.plist` is wired in `config/electron-builder.json` for main and child processes. Adjust if you add new capabilities (e.g. sandbox).
3. **Build**: from `desktop/`, run `npm run dist`. Electron Builder signs the app bundle when `CSC_LINK` / `CSC_KEY_PASSWORD` or keychain identity is configured.
4. **Notarization** (example with `notarytool`):

```bash
xcrun notarytool submit "release/Pulse HUD-1.0.0-arm64.dmg" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

xcrun stapler staple "release/mac-arm64/Pulse HUD.app"
```

Store secrets in CI, not in the repo. Use an app-specific password for Apple ID.

5. **Smoke test (clean VM)**: Install from DMG, launch, complete login, start embedded HUD session, mic + system-audio capture once, quit and relaunch (SQLite reload).

## Windows (NSIS)

1. **Certificate**: Install a code-signing cert (Authenticode). Set `CSC_LINK` to the `.pfx` path and `CSC_KEY_PASSWORD` for `electron-builder`.
2. **Build**: `npm run dist` produces `release/*.exe` (NSIS).
3. **Smoke test (clean VM)**: Run installer, launch from Start menu, first-run SmartScreen may require reputation or an EV cert; verify HUD + embedded server.

## Offline / embedded

Desktop always passes `--server-port=` to the renderer; the client forces API, WebSocket, and transcribe to `127.0.0.1` while that port is set, so packaging smoke tests do not require Cloud Run.
