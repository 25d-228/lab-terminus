# Lab Terminus

A cross-platform desktop app to manage an NLP lab's server fleet — one window for every
machine, with a Termius-style host list and per-server **Explorer / Terminal / Monitor**
tabs. WSL counts as a server; the Synology NAS is a storage host.

## Stack

- **Shell:** Tauri 2 (Rust core + system webview).
- **Core (Rust, incremental):** SSH/SFTP via `russh` + `russh-sftp`, local WSL PTY via
  `portable-pty`, Synology DSM via `reqwest`.
- **Frontend:** Vite, React, strict TypeScript, Tailwind CSS, shadcn/ui Base UI, and
  bundled xterm.js.

## Develop

```sh
npm ci               # install the locked frontend dependencies
npm run build        # type-check and produce dist/ for the Rust embed
cargo tauri dev      # rebuild the frontend, compile Rust, and open the app
cargo tauri build    # rebuild the frontend and produce installers (unsigned)
```

## Validate

```sh
npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Requires the Rust toolchain (MSVC on Windows), Node, and the Tauri CLI (`cargo tauri`).

## Status

The Tauri window loads the production bundle from the Rust loopback server. The Rust
core provides the SSH/SFTP/PTY/DSM services used by the React application.
