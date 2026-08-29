# Contributing to Tatas Killer

Thank you for helping improve Tatas Killer.

## Before you start

- Search existing issues before opening a duplicate report.
- Keep changes focused on one problem or feature.
- Discuss large architecture changes before investing in an implementation.
- Never include credentials, private repository paths, or production process data in an issue or commit.

## Set up the project

Follow the prerequisites and local setup in [README.md](README.md), then read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Branches and commits

Create a branch from the current default branch:

```powershell
git switch -c feature/short-description
```

Use clear, imperative commit messages, for example:

```text
Add Linux listener discovery
Fix duplicate dual-stack ports
Document restart safety constraints
```

## Quality checklist

Before opening a pull request:

```powershell
npm run build
cd src-tauri
cargo fmt --check
cargo check
```

Also verify manually that:

- scanning does not freeze the UI;
- IPv4 and IPv6 listeners are represented correctly;
- one PID/port is not displayed twice;
- editor tooling is not treated as a project runtime;
- kill and restart confirmations identify the correct target;
- dark and light themes remain readable;
- user-facing copy is in English.

## Pull requests

Include:

- a concise problem statement;
- the chosen approach and relevant trade-offs;
- verification steps;
- screenshots for visual changes;
- platform and OS version for process-management changes.

Process management is platform-sensitive. Avoid assuming behavior observed on one operating system applies to another.

