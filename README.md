# Tatas Killer

Tatas Killer is a local port and process manager for developer workstations. It helps identify which project owns a listening port, inspect its process tree, monitor resource usage, and stop or restart development processes without repeatedly switching to a terminal.

> **Project status:** early development (`0.1.0`). Port discovery, process termination, and quick restart currently support Windows. macOS/Linux adapters and system-tray behavior are planned.

## Features

- Discover active TCP listeners, including IPv4 and IPv6 sockets.
- Resolve PID, process name, working directory, and project metadata.
- Recognize Node.js/Vite/Next.js/NestJS, Go/Gin, and Rust projects.
- Separate developer processes from system processes.
- Group project runtimes into workspaces.
- Stop one process tree, multiple selected processes, or a workspace.
- Inspect parent/child dependencies in a visual process tree.
- Monitor CPU and RAM usage for listeners and workspaces.
- Restart supported development commands from the correct directory.
- Search by project, framework, port, PID, process, address, or path.
- Light and dark themes.

## Safety

Tatas Killer can forcibly terminate processes. Before performing a kill or restart, it asks for confirmation. Windows system PIDs and the Tatas Killer process itself are protected. Quick Restart only accepts commands detected from project manifests and restricted to an internal allowlist.

Review the selected PID and working directory before confirming an operation. Unsaved in-memory work owned by a terminated process may be lost.

## Tech stack

- [Tauri v2](https://v2.tauri.app/) and Rust
- React 19 and TypeScript
- Vite
- `sysinfo` for process metadata and resource metrics
- Native Windows tools (`netstat.exe` and `taskkill.exe`)

## Prerequisites

For Windows development, install:

- Node.js 20 or newer and npm
- Rust stable with the MSVC toolchain
- Microsoft C++ Build Tools with **Desktop development with C++**
- Microsoft Edge WebView2 Runtime

See the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) if the native build toolchain is not yet configured.

## Run locally

Clone the repository and install JavaScript dependencies:

```powershell
git clone https://github.com/AsrofunNiam/tatas_killer.git
cd tatas_killer
npm install
```

Start the complete desktop application:

```powershell
npm run tauri dev
```

On Windows systems that block PowerShell script shims, use:

```powershell
npm.cmd run tauri dev
```

Running `npm run dev` starts only the Vite frontend. Native process commands require the Tauri desktop runtime and will not work in a normal browser tab.

## Validation and production build

```powershell
# Type-check and bundle the frontend
npm run build

# Check the Rust backend
cd src-tauri
cargo check

# Build platform installers/bundles
cd ..
npm run tauri build
```

Generated installers are written below `src-tauri/target/release/bundle/`.

## Project structure

```text
tatas_killer/
|-- public/                    Static frontend assets
|-- src/
|   |-- App.tsx               UI, application state, and Tauri invocations
|   |-- App.css               Theme tokens and component styles
|   `-- main.tsx              React entry point
|-- src-tauri/
|   |-- capabilities/         Tauri permission declarations
|   |-- icons/                Desktop application icons
|   |-- src/
|   |   |-- lib.rs            Scanner, recognition, metrics, kill, and restart logic
|   |   `-- main.rs           Native executable entry point
|   |-- Cargo.toml            Rust dependencies
|   `-- tauri.conf.json       Window, build, and bundle configuration
|-- docs/
|   |-- ARCHITECTURE.md       Components, data flow, and safety boundaries
|   `-- DEVELOPMENT.md        Local workflow and troubleshooting
|-- CONTRIBUTING.md           Contribution process
|-- package.json              Frontend dependencies and scripts
`-- vite.config.ts            Vite development configuration
```

For more detail, read [Architecture](docs/ARCHITECTURE.md) and [Development Guide](docs/DEVELOPMENT.md).

## Current limitations

- OS process operations are implemented for Windows only.
- Framework recognition is heuristic and intentionally conservative.
- A process appears only when it owns a TCP listening socket.
- CPU metrics need at least two snapshots before becoming representative.
- Quick Restart supports `npm`, `pnpm`, `yarn`, `bun`, and `go run .` presets only.
- Background zombie/idle detection and automatic cleanup are not implemented yet.
- System-tray lifecycle behavior is not implemented yet.

## Roadmap

- macOS support through `lsof` and native signals.
- Linux support through `/proc`, `ss`, or `lsof`.
- System tray, background monitoring, and desktop notifications.
- Configurable idle-process policies and opt-in automatic cleanup.
- Additional manifest and framework detectors.
- Automated Rust and frontend test coverage.

## Contributing

Contributions and bug reports are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

A license has not been selected yet. Add a `LICENSE` file before distributing the project as open-source software.
