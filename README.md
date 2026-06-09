# Lab Terminus

A cross-platform desktop app to manage an NLP lab's server fleet — one window for every
machine, with a Termius-style host list and per-server **Explorer / Terminal / Monitor**
tabs. WSL counts as a server; the Synology NAS is a storage host.

## Stack

- **Shell:** Tauri 2 (Rust core + system webview).
- **Core (Rust, incremental):** SSH/SFTP via `russh` + `russh-sftp`, local WSL PTY via
  `portable-pty`, Synology DSM via `reqwest`.
- **Frontend:** plain HTML/CSS/JS + `xterm.js` (in `web/`), ported from the validated
  Python prototype.

## Develop

```sh
cargo tauri dev      # compile the Rust core + open the window (first build is slow)
cargo tauri build    # produce installers (unsigned)
```

Requires the Rust toolchain (MSVC on Windows), Node, and the Tauri CLI (`cargo tauri`).

## Status

Scaffolding stage: the window opens on the web frontend. The Rust SSH/SFTP/PTY/DSM
core is being ported feature-by-feature against the working prototype as the reference.
