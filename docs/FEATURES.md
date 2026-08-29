# Features and Advantages

This document describes the capabilities currently implemented in Tatas Killer and why they are useful in a local development workflow. Planned features are kept in the README roadmap and are not presented here as completed functionality.

## Project-aware port discovery

Traditional port tools usually stop at an address, PID, and executable name. That is often insufficient because many development servers appear only as `node.exe`, `main.exe`, or `python.exe`.

Tatas Killer enriches every TCP listener with:

- process ID and executable name;
- IPv4 and IPv6 bind addresses;
- current working directory;
- repository or package name;
- detected framework;
- process classification and operating-system status.

Manifest inspection currently recognizes `package.json`, `go.mod`, and `Cargo.toml`. Known development tools such as VS Code are classified before manifest inspection so an editor opened inside a repository is not mistaken for the project's server.

### Advantage

Instead of seeing only `node.exe :5173`, a developer can see `Vite — my-project :5173` and immediately understand what owns the port.

## Clean IPv4 and IPv6 representation

Windows may report one dual-stack service as separate IPv4 and IPv6 listeners. Tatas Killer groups entries by PID and port, retains all bind addresses, and displays one logical listener.

### Advantage

The interface avoids duplicate cards while still preserving useful network-binding information. It also detects Vite instances bound only to IPv6 loopback, such as `[::1]:5173`.

## Developer, system, and workspace grouping

Listeners are separated into developer and system groups. Project runtimes can also be viewed as workspaces, while editor tooling remains visible but is excluded from destructive workspace actions.

### Advantage

System socket noise does not obscure active projects, and a workspace operation does not accidentally close VS Code merely because the editor's working directory points to the same repository.

## Visual process dependency tree

Clicking a process card loads its parent/child tree on demand. A tree can expose relationships such as:

```text
npm
`-- node
    |-- vite
    `-- esbuild
```

Tree traversal stops at boundaries such as the terminal, editor, or Windows Explorer and applies depth and node limits.

### Advantage

A developer can understand why killing one PID did not stop a server, or which child tools belong to the same development command, without manually reconstructing process ancestry.

## Verified process termination

Tatas Killer supports:

- one-process-tree termination;
- checkbox-based bulk termination;
- workspace termination;
- special handling for temporary binaries created by `go run`.

The backend protects system PIDs and its own application PID, deduplicates runtime roots, and checks that a listener disappeared before reporting success.

### Advantage

Success reflects the observed process state rather than only the exit code returned by `taskkill`.

## One-click Quick Restart

When a supported manifest is found, Tatas Killer can stop the old runtime and reopen an allowlisted development command from the correct directory. Current presets include:

- `npm run dev`
- `pnpm run dev`
- `yarn run dev`
- `bun run dev`
- `go run .`

A new console remains visible so the developer can continue reading server logs.

### Advantage

The common recovery loop—find the port, kill the stale tree, navigate to the project, and run the development command again—becomes one confirmed action.

## CPU and RAM insights

CPU and memory statistics refresh in the background. Listener metrics include the relevant child runtime tree, and workspace totals deduplicate PIDs that expose multiple ports. Process cards are ordered by descending memory usage.

### Advantage

The interface provides immediate context about which local development service consumes the most resources, not merely which ports are occupied.

## Port reservations and collision protection

A developer can pin a port to a recognized project. Tatas Killer persists the reservation locally and scans for ownership changes in the background.

When a different owner appears, it can:

- show an in-app collision warning;
- send a native desktop notification;
- optionally terminate the intruding process when auto-kill was explicitly enabled for that port.

Vite normally avoids a hard collision by incrementing to the next free port. While the reserved owner remains active, Tatas Killer also recognizes another Vite project appearing within the next ten ports as a probable fallback and reports both the requested and fallback ports. Because this is heuristic rather than an actual hijack, auto-kill is not applied.

Auto-kill is disabled by default. Protection is reactive: the application detects an unexpected listener after it binds and then responds.

### Advantage

Frequently used ports become documented local contracts, making accidental project-to-project port conflicts visible without permanently occupying those ports.

## Search and focused navigation

Search covers ports, PIDs, project names, frameworks, process names, addresses, types, and working directories. Results remain organized in collapsible groups, with dedicated views for ports, workspaces, reservations, and zombie status.

### Advantage

The same interface remains practical when a workstation has many system and development listeners.

## Local-first and privacy-conscious

Scanning, recognition, metrics, process control, and reservations run locally. Tatas Killer does not require an account or send process metadata to a remote service.

### Advantage

Repository paths, process details, and development topology stay on the developer's machine.

## Theme and responsive desktop layout

The interface supports persisted light and dark themes. Cards adapt their information and actions to narrower windows instead of forcing every field into a rigid table row.

### Advantage

The application remains readable as a compact utility window as well as a larger process dashboard.

## Workflow comparison

| Task | Typical manual workflow | Tatas Killer |
| --- | --- | --- |
| Identify port owner | Run `netstat`, copy PID, inspect Task Manager | Shows project, framework, path, PID, and port together |
| Diagnose stubborn server | Reconstruct parent/child processes manually | Click the process card to inspect its tree |
| Stop several services | Run multiple commands or terminate PIDs one by one | Select processes or terminate a workspace |
| Recover a dev server | Find directory and rerun the package command | Use a validated Quick Restart action |
| Notice port takeover | Discover it after a server fails to bind | Receive a collision warning or native notification |
| Find heavy local services | Cross-reference Task Manager with port output | View CPU/RAM beside each listener and workspace |

## Current platform scope

The advantages above describe the current Windows implementation. macOS and Linux process adapters remain roadmap items. Background idle/zombie policy automation and system-tray lifecycle behavior are also not complete yet.
