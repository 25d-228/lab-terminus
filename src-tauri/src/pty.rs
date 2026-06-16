//! PTY terminal over a WebSocket (ported from the prototype's /api/{id}/pty):
//! SSH hosts use a russh interactive shell; WSL uses portable-pty around wsl.exe.
use std::io::{Read, Write};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::config::{self, Server};
use crate::ssh;

// Fallback terminal geometry when the client doesn't supply one.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const PTY_READ_BUFFER_BYTES: usize = 8192;

#[derive(Deserialize)]
pub struct PtyQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub async fn pty_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(q): Query<PtyQuery>,
) -> Response {
    let cols = q.cols.unwrap_or(DEFAULT_COLS);
    let rows = q.rows.unwrap_or(DEFAULT_ROWS);
    let Some(s) = config::find(&id) else {
        return (StatusCode::NOT_FOUND, "unknown server").into_response();
    };
    if s.kind == "nas" {
        return (StatusCode::BAD_REQUEST, "no terminal for this host").into_response();
    }
    ws.on_upgrade(move |socket| async move {
        match s.kind.as_str() {
            "ssh" => ssh_pty(s, socket, cols, rows).await,
            "wsl" => wsl_pty(socket, cols, rows).await,
            _ => {}
        }
    })
}

async fn send_err(socket: &mut WebSocket, msg: &str) {
    let _ = socket
        .send(Message::Binary(
            format!("\r\n\x1b[31m{msg}\x1b[0m\r\n").into_bytes().into(),
        ))
        .await;
    let _ = socket.close().await;
}

async fn ssh_pty(s: Server, mut socket: WebSocket, cols: u16, rows: u16) {
    let handle = match ssh::connect(&s).await {
        Ok(h) => h,
        Err(e) => return send_err(&mut socket, &format!("SSH connect failed: {e}")).await,
    };
    let mut ch = match handle.channel_open_session().await {
        Ok(c) => c,
        Err(e) => return send_err(&mut socket, &format!("channel failed: {e}")).await,
    };
    if ch
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .is_err()
        || ch.request_shell(false).await.is_err()
    {
        return send_err(&mut socket, "failed to start shell").await;
    }
    let (mut sink, mut stream) = socket.split();
    let mut writer = ch.make_writer();
    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if writer.write_all(&b[..]).await.is_err() { break; }
                    let _ = writer.flush().await;
                }
                Some(Ok(Message::Text(_))) => { /* resize skipped: russh channel is busy in wait() */ }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            c = ch.wait() => match c {
                Some(russh::ChannelMsg::Data { ref data })
                | Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    if sink.send(Message::Binary(data[..].to_vec().into())).await.is_err() { break; }
                }
                None => break,
                _ => {}
            }
        }
    }
}

async fn wsl_pty(socket: WebSocket, cols: u16, rows: u16) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let distro = config::get()
        .wsl
        .as_ref()
        .and_then(|w| w.distro.clone())
        .unwrap_or_else(|| "Ubuntu".into());
    let sys = native_pty_system();
    let Ok(pair) = sys.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) else {
        return;
    };
    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(["-d", distro.as_str()]);
    let Ok(_child) = pair.slave.spawn_command(cmd) else {
        return;
    };
    drop(pair.slave);
    let Ok(mut reader) = pair.master.try_clone_reader() else {
        return;
    };
    let Ok(mut pwriter) = pair.master.take_writer() else {
        return;
    };
    let master = pair.master;

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; PTY_READ_BUFFER_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(d) = in_rx.recv() {
            if pwriter.write_all(&d).is_err() {
                break;
            }
            let _ = pwriter.flush();
        }
    });

    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(d) => { if sink.send(Message::Binary(d.into())).await.is_err() { break; } }
                None => break,
            },
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) => { if in_tx.send(b.to_vec()).is_err() { break; } }
                Some(Ok(Message::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) else { continue; };
                    if v["t"].as_str() != Some("r") { continue; }
                    let _ = master.resize(PtySize {
                        rows: v["r"].as_u64().unwrap_or(DEFAULT_ROWS as u64) as u16,
                        cols: v["c"].as_u64().unwrap_or(DEFAULT_COLS as u64) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}
