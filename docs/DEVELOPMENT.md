# Development Guide

## Common commands

Run these commands from the repository root unless stated otherwise.

```powershell
npm install              # Install frontend and Tauri CLI dependencies
npm run tauri dev        # Run the complete desktop application
npm run dev              # Run only the Vite frontend
npm run build            # Type-check and bundle the frontend
npm run tauri build      # Create a release build and installer
```

Rust checks:

```powershell
cd src-tauri
cargo fmt --check
cargo check
```

If PowerShell blocks `npm.ps1`, replace `npm` with `npm.cmd`.

## Development workflow

1. Start the app with `npm run tauri dev`.
2. Frontend changes hot-reload through Vite.
3. Rust changes trigger a native rebuild and application restart.
4. Start a local server such as Vite or Gin.
5. Select **Scan again** if the listener was created after the last scan.
6. Validate IPv4 and IPv6 listeners when changing scanner behavior.

Do not use Tatas Killer to terminate a process containing unsaved work.

## Adding a Tauri command

1. Implement a small Rust command in `src-tauri/src/lib.rs`.
2. Keep blocking work outside the async/UI thread with `spawn_blocking`.
3. Return `Result<T, String>` with actionable, user-facing English errors.
4. Serialize response fields with `camelCase` for TypeScript.
5. Register the command in `tauri::generate_handler!`.
6. Add a matching TypeScript response type.
7. Invoke it through `@tauri-apps/api/core`.
8. Re-check Tauri capabilities if a plugin permission is required.

## Adding framework recognition

Framework detectors should:

- rely on a stable manifest or dependency marker;
- avoid executing project code;
- tolerate missing, unreadable, or invalid files;
- limit ancestor traversal;
- distinguish runtime processes from editor tooling;
- avoid labeling a process when evidence is ambiguous.

## Generated and local files

Do not commit:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/gen/schemas/`
- `.env` or secret-bearing local files
- logs and editor-specific state

Commit both `package-lock.json` and `src-tauri/Cargo.lock` for reproducible application builds.

## Troubleshooting

### A server does not appear

- Confirm that it owns a listening socket with `Get-NetTCPConnection -State Listen`.
- Click **Scan again**.
- Clear the search field and expand the relevant process group.
- Enable **Show internal tools** if the process is classified as tooling.
- Check whether the service runs inside Docker or WSL rather than directly on the host.

The Windows scanner supports both `127.0.0.1:PORT` and `[::1]:PORT`.

### Rust build waits for a lock

Another `cargo`, Tauri development process, or IDE analyzer may be using the target directory. Wait for that build to finish. Do not delete the target directory while Cargo is running.

### Process termination is denied

The target may run at a higher integrity level or belong to another user. Restart Tatas Killer with appropriate permissions only when the target is trusted and understood.

### CPU initially displays zero

CPU usage is calculated from the difference between snapshots. Allow at least one polling interval for a representative value.

### Quick Restart is unavailable

Quick Restart is shown only when Tatas Killer finds a supported manifest and command. Current presets are:

- `npm run dev`
- `pnpm run dev`
- `yarn run dev`
- `bun run dev`
- `go run .`

