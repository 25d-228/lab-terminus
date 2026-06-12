//! File-transfer engine (ported from the prototype's transfers.py).
//!
//! Three flavors, one job queue:
//!   - copy     : remote → remote (server↔server, server↔NAS), streamed in chunks
//!   - upload   : browser → SSH host (drag-drop / ⇪ button), request body streamed to SFTP
//!   - download : SSH/NAS host → browser (<a href> → the window's on_download handler
//!                saves it to the user's Downloads folder)
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, Query, Request};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::TryStreamExt;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{config, nas, ssh};

const CHUNK: usize = 1 << 20; // 1 MiB

// ---------------------------------------------------------------- job registry
#[derive(Clone)]
pub struct Job {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    pub total: u64,
    pub done: u64,
    pub state: &'static str, // queued | active | done | error | canceled
    pub error: Option<String>,
    pub speed: f64,
    pub ts: f64,
    started: Option<f64>,
    cancel: Arc<AtomicBool>,
}

impl Job {
    fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id, "kind": self.kind, "label": self.label, "total": self.total,
            "done": self.done, "state": self.state, "error": self.error,
            "speed": self.speed, "ts": self.ts
        })
    }
}

static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn mkjob(kind: &'static str, label: String, total: u64) -> (String, Arc<AtomicBool>) {
    let id = format!("{:x}{:x}", SEQ.fetch_add(1, Ordering::Relaxed), now() as u64);
    let cancel = Arc::new(AtomicBool::new(false));
    let job = Job {
        id: id.clone(),
        kind,
        label,
        total,
        done: 0,
        state: "queued",
        error: None,
        speed: 0.0,
        ts: now(),
        started: None,
        cancel: cancel.clone(),
    };
    jobs().lock().unwrap().insert(id.clone(), job);
    (id, cancel)
}

fn update(id: &str, f: impl FnOnce(&mut Job)) {
    if let Some(j) = jobs().lock().unwrap().get_mut(id) {
        f(j);
    }
}

fn add_progress(id: &str, n: u64) {
    update(id, |j| {
        j.done += n;
        if j.started.is_none() {
            j.started = Some(now());
        }
        if let Some(t0) = j.started {
            let dt = now() - t0;
            if dt > 0.0 {
                j.speed = j.done as f64 / dt;
            }
        }
    });
}

// ---------------------------------------------------------------- io endpoints per kind
async fn sftp_for(s: &config::Server) -> Result<russh_sftp::client::SftpSession, String> {
    let handle = ssh::connect(s).await?;
    let ch = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    ch.request_subsystem(true, "sftp")
        .await
        .map_err(|e| e.to_string())?;
    russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .map_err(|e| e.to_string())
}

enum Reader {
    Sftp(russh_sftp::client::fs::File),
    Http(Box<dyn tokio::io::AsyncRead + Send + Unpin>),
}

impl Reader {
    async fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        match self {
            Reader::Sftp(f) => f.read(buf).await.map_err(|e| e.to_string()),
            Reader::Http(r) => r.read(buf).await.map_err(|e| e.to_string()),
        }
    }
}

/// Open a remote file for reading; returns (reader, total bytes if known).
async fn open_reader(s: &config::Server, path: &str) -> Result<(Reader, u64), String> {
    match s.kind.as_str() {
        "ssh" => {
            let sftp = sftp_for(s).await?;
            let total = sftp
                .metadata(path)
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0);
            let f = sftp.open(path).await.map_err(|e| e.to_string())?;
            Ok((Reader::Sftp(f), total))
        }
        "nas" => {
            let resp = nas::download(path).await?;
            let total = resp.content_length().unwrap_or(0);
            let stream = resp
                .bytes_stream()
                .map_err(|e| std::io::Error::other(e.to_string()));
            Ok((
                Reader::Http(Box::new(tokio_util::io::StreamReader::new(stream))),
                total,
            ))
        }
        k => Err(format!("transfers not supported for kind={k}")),
    }
}

// ---------------------------------------------------------------- copy job (remote → remote)
fn basename(p: &str) -> String {
    p.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("file")
        .to_string()
}

async fn copy_worker(
    id: String,
    cancel: Arc<AtomicBool>,
    src: config::Server,
    src_path: String,
    dst: config::Server,
    dst_dir: String,
) {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let _permit = SLOTS
        .get_or_init(|| tokio::sync::Semaphore::new(3))
        .acquire()
        .await;
    if cancel.load(Ordering::Relaxed) {
        update(&id, |j| j.state = "canceled");
        return;
    }
    update(&id, |j| j.state = "active");
    let name = basename(&src_path);
    let result: Result<(), String> = async {
        let (mut reader, total) = open_reader(&src, &src_path).await?;
        if total > 0 {
            update(&id, |j| j.total = total);
        }
        match dst.kind.as_str() {
            "ssh" => {
                let sftp = sftp_for(&dst).await?;
                let dst_path = format!("{}/{}", dst_dir.trim_end_matches('/'), name);
                let mut out = sftp.create(&dst_path).await.map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("__canceled".into());
                    }
                    let n = reader.read_chunk(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                    add_progress(&id, n as u64);
                }
                out.shutdown().await.map_err(|e| e.to_string())?;
                Ok(())
            }
            "nas" => {
                // DSM rejects chunked uploads, so the multipart needs a known length.
                if total > 0 {
                    // stream the reader through a channel, declaring the length up front
                    let (tx, rx) =
                        tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);
                    let cid = id.clone();
                    let cancel2 = cancel.clone();
                    let pump = tokio::spawn(async move {
                        let mut buf = vec![0u8; CHUNK];
                        loop {
                            if cancel2.load(Ordering::Relaxed) {
                                let _ = tx.send(Err(std::io::Error::other("canceled"))).await;
                                return Err("__canceled".to_string());
                            }
                            match reader.read_chunk(&mut buf).await {
                                Ok(0) => return Ok(()),
                                Ok(n) => {
                                    add_progress(&cid, n as u64);
                                    if tx.send(Ok(buf[..n].to_vec())).await.is_err() {
                                        return Ok(());
                                    }
                                }
                                Err(e) => {
                                    let _ =
                                        tx.send(Err(std::io::Error::other(e.clone()))).await;
                                    return Err(e);
                                }
                            }
                        }
                    });
                    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
                    nas::upload(
                        &dst_dir,
                        &name,
                        reqwest::Body::wrap_stream(stream),
                        total,
                        true,
                    )
                    .await?;
                    match pump.await {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(e)) => Err(e),
                        Err(e) => Err(e.to_string()),
                    }
                } else {
                    // size unknown — buffer (rare: only NAS→NAS of unknown length)
                    let mut data = Vec::new();
                    let mut buf = vec![0u8; CHUNK];
                    loop {
                        if cancel.load(Ordering::Relaxed) {
                            return Err("__canceled".into());
                        }
                        let n = reader.read_chunk(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        data.extend_from_slice(&buf[..n]);
                        add_progress(&id, n as u64);
                    }
                    let len = data.len() as u64;
                    nas::upload(&dst_dir, &name, reqwest::Body::from(data), len, true).await
                }
            }
            k => Err(format!("cannot write to kind={k}")),
        }
    }
    .await;
    match result {
        Ok(()) => update(&id, |j| {
            j.state = "done";
            if j.total < j.done {
                j.total = j.done;
            }
        }),
        Err(e) if e == "__canceled" => update(&id, |j| j.state = "canceled"),
        Err(e) => update(&id, |j| {
            j.state = "error";
            j.error = Some(e);
        }),
    }
}

// ---------------------------------------------------------------- axum handlers
fn find(id: &str) -> Option<config::Server> {
    config::get().servers.iter().find(|s| s.id == id).cloned()
}

pub async fn list() -> impl IntoResponse {
    let mut v: Vec<Job> = jobs().lock().unwrap().values().cloned().collect();
    v.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
    Json(serde_json::json!({ "jobs": v.iter().map(|j| j.public()).collect::<Vec<_>>() }))
}

pub async fn cancel(Path(jid): Path<String>) -> impl IntoResponse {
    let ok = {
        let map = jobs().lock().unwrap();
        match map.get(&jid) {
            Some(j) if j.state == "queued" || j.state == "active" => {
                j.cancel.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    };
    Json(serde_json::json!({ "ok": ok }))
}

pub async fn clear() -> impl IntoResponse {
    jobs()
        .lock()
        .unwrap()
        .retain(|_, j| j.state == "queued" || j.state == "active");
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct CopyBody {
    src: CopyEnd,
    dst: CopyEnd,
}

#[derive(Deserialize)]
pub struct CopyEnd {
    sid: String,
    path: String,
    #[serde(default)]
    size: Option<u64>,
}

pub async fn copy(Json(b): Json<CopyBody>) -> Response {
    let (Some(src), Some(dst)) = (find(&b.src.sid), find(&b.dst.sid)) else {
        return (StatusCode::BAD_REQUEST, "bad src/dst").into_response();
    };
    if b.src.path.is_empty() || b.dst.path.is_empty() {
        return (StatusCode::BAD_REQUEST, "bad src/dst").into_response();
    }
    let label = format!(
        "{} : {}  →  {}",
        src.name,
        basename(&b.src.path),
        dst.name
    );
    let (id, cancel) = mkjob("copy", label, b.src.size.unwrap_or(0));
    let (sp, dp) = (b.src.path.clone(), b.dst.path.clone());
    tokio::spawn(copy_worker(id.clone(), cancel, src, sp, dst, dp));
    let j = jobs().lock().unwrap().get(&id).map(|j| j.public());
    Json(j.unwrap_or(serde_json::json!({}))).into_response()
}

#[derive(Deserialize)]
pub struct DlQuery {
    path: String,
}

pub async fn download(Path(id): Path<String>, Query(q): Query<DlQuery>) -> Response {
    let Some(s) = find(&id) else {
        return (StatusCode::NOT_FOUND, "unknown server").into_response();
    };
    let (reader, total) = match open_reader(&s, &q.path).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let name = basename(&q.path);
    let stream = futures_util::stream::try_unfold(reader, |mut r| async move {
        let mut buf = vec![0u8; CHUNK];
        let n = r
            .read_chunk(&mut buf)
            .await
            .map_err(std::io::Error::other)?;
        if n == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buf.truncate(n);
            Ok(Some((bytes::Bytes::from(buf), r)))
        }
    });
    let mut resp = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename*=UTF-8''{}",
                urlencode(&name)
            ),
        );
    if total > 0 {
        resp = resp.header(header::CONTENT_LENGTH, total.to_string());
    }
    resp.body(Body::from_stream(stream))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "stream").into_response())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
pub struct UpQuery {
    path: String,
    name: String,
}

pub async fn upload(Path(id): Path<String>, Query(q): Query<UpQuery>, req: Request) -> Response {
    let Some(s) = find(&id) else {
        return (StatusCode::NOT_FOUND, "unknown server").into_response();
    };
    if s.kind != "ssh" {
        return (StatusCode::BAD_REQUEST, "upload supported on SSH hosts only (for now)")
            .into_response();
    }
    let total: u64 = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let (id_job, cancel) = mkjob("upload", format!("↑ {}  →  {}", q.name, s.name), total);
    update(&id_job, |j| j.state = "active");
    let result: Result<(), String> = async {
        let sftp = sftp_for(&s).await?;
        let dst = format!("{}/{}", q.path.trim_end_matches('/'), q.name);
        let mut out = sftp.create(&dst).await.map_err(|e| e.to_string())?;
        let mut stream = req.into_body().into_data_stream();
        while let Some(chunk) = stream.try_next().await.map_err(|e| e.to_string())? {
            if cancel.load(Ordering::Relaxed) {
                return Err("__canceled".into());
            }
            out.write_all(&chunk).await.map_err(|e| e.to_string())?;
            add_progress(&id_job, chunk.len() as u64);
        }
        out.shutdown().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            update(&id_job, |j| {
                j.state = "done";
                if j.total < j.done {
                    j.total = j.done;
                }
            });
            let j = jobs().lock().unwrap().get(&id_job).map(|j| j.public());
            Json(serde_json::json!({"ok": true, "job": j})).into_response()
        }
        Err(e) => {
            let canceled = e == "__canceled";
            update(&id_job, |j| {
                if canceled {
                    j.state = "canceled";
                } else {
                    j.state = "error";
                    j.error = Some(e.clone());
                }
            });
            (StatusCode::BAD_REQUEST, if canceled { "canceled".into() } else { e })
                .into_response()
        }
    }
}
