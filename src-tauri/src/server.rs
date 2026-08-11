//! Embedded loopback API server (axum) mirroring the prototype's routes, so the
//! existing web frontend works unchanged.
use axum::{
    extract::{Path, Query},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::Deserialize;

use crate::{config, ssh};

#[derive(RustEmbed)]
#[folder = "../web"]
struct Assets;

pub fn router() -> Router {
    Router::new()
        .route("/api/servers", get(servers).post(server_add))
        .route("/api/servers/{sid}", put(server_edit).delete(server_del))
        .route("/api/folders", get(folders).post(folder_add))
        .route("/api/folders/{key}", put(folder_edit).delete(folder_del))
        .route("/api/fleet", get(fleet))
        .route("/api/{id}/status", get(host_status))
        .route("/api/{id}/ls", get(ls))
        .route("/api/{id}/exec", post(exec_cmd))
        .route("/api/{id}/fs", post(fs_op))
        .route("/api/{id}/pty", get(crate::pty::pty_handler))
        .route("/api/transfers", get(crate::transfers::list))
        .route("/api/transfers/copy", post(crate::transfers::copy))
        .route("/api/transfers/clear", post(crate::transfers::clear))
        .route(
            "/api/transfers/{jid}/cancel",
            post(crate::transfers::cancel),
        )
        .route("/api/{id}/download", get(crate::transfers::download))
        .route("/api/{id}/upload", post(crate::transfers::upload))
        // streamed uploads can be arbitrarily large — drop axum's 2 MiB default cap
        .layer(axum::extract::DefaultBodyLimit::disable())
        .fallback(static_handler)
}

fn err400(e: String) -> Response {
    (StatusCode::BAD_REQUEST, e).into_response()
}

/// The 404 returned by every handler when a path's server id isn't in the registry.
fn unknown_server() -> Response {
    (StatusCode::NOT_FOUND, "unknown server").into_response()
}

/// Public view of a server — fixed allowlist (like the prototype's _PUBLIC), so anything
/// extra a user hand-adds to the config file never leaks through the API.
fn public(s: &config::Server) -> serde_json::Value {
    serde_json::json!({
        "id": s.id, "name": s.name, "kind": s.kind, "host": s.host, "port": s.port,
        "user": s.user, "gpuLabel": s.gpu_label, "home": s.home, "group": s.group,
        "custom": s.custom
    })
}

async fn servers() -> impl IntoResponse {
    Json(config::get().servers.iter().map(public).collect::<Vec<_>>())
}

async fn folders() -> impl IntoResponse {
    Json(config::get().folders.clone())
}

async fn server_add(Json(b): Json<serde_json::Value>) -> Response {
    match config::add_server(&b) {
        Ok(s) => Json(public(&s)).into_response(),
        Err(e) => err400(e),
    }
}

async fn server_edit(Path(sid): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    match config::edit_server(&sid, &b) {
        Ok(s) => Json(public(&s)).into_response(),
        Err(e) => err400(e),
    }
}

async fn server_del(Path(sid): Path<String>) -> Response {
    match config::remove_server(&sid) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => err400(e),
    }
}

async fn folder_add(Json(b): Json<serde_json::Value>) -> Response {
    match config::add_folder(b["title"].as_str().unwrap_or("")) {
        Ok(f) => Json(f).into_response(),
        Err(e) => err400(e),
    }
}

async fn folder_edit(Path(key): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    match config::rename_folder(&key, b["title"].as_str().unwrap_or("")) {
        Ok(f) => Json(f).into_response(),
        Err(e) => err400(e),
    }
}

async fn folder_del(Path(key): Path<String>) -> Response {
    match config::remove_folder(&key) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => err400(e),
    }
}

async fn fleet() -> impl IntoResponse {
    Json(serde_json::json!({ "servers": ssh::fleet().await, "rev": config::rev() }))
}

async fn host_status(Path(id): Path<String>) -> Response {
    let Some(s) = config::find(&id) else {
        return unknown_server();
    };
    Json(ssh::status_for(s).await).into_response()
}

#[derive(Deserialize)]
struct LsQuery {
    path: Option<String>,
}

async fn ls(Path(id): Path<String>, Query(q): Query<LsQuery>) -> Response {
    let Some(s) = config::find(&id) else {
        return unknown_server();
    };
    let v = match s.kind.as_str() {
        "wsl" => crate::wsl::ls_dir(&s, q.path.as_deref()).await,
        "nas" => crate::nas::ls_dir(&s, q.path.as_deref()).await,
        _ => ssh::ls_dir(&s, q.path.as_deref()).await,
    };
    Json(v).into_response()
}

#[derive(Deserialize)]
struct FsBody {
    op: String,
    path: String,
    #[serde(default)]
    to: Option<String>,
}

// Reject traversal / control chars at the boundary so no transport can be tricked into
// escaping the viewed directory, even if the frontend guard is bypassed.
fn has_unsafe_path(p: &str) -> bool {
    p.split('/').any(|seg| seg == "..") || p.chars().any(|c| c.is_control())
}

async fn fs_op(Path(id): Path<String>, Json(b): Json<FsBody>) -> Response {
    let Some(s) = config::find(&id) else {
        return unknown_server();
    };
    if has_unsafe_path(&b.path) || b.to.as_deref().is_some_and(has_unsafe_path) {
        return err400("invalid path".into());
    }
    let r = match s.kind.as_str() {
        "wsl" => crate::wsl::fs_op(&s, &b.op, &b.path, b.to.as_deref()).await,
        "nas" => crate::nas::fs_op(&s, &b.op, &b.path, b.to.as_deref()).await,
        _ => ssh::fs_op(&s, &b.op, &b.path, b.to.as_deref()).await,
    };
    match r {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => err400(e),
    }
}

#[derive(Deserialize)]
struct ExecBody {
    cwd: Option<String>,
    cmd: Option<String>,
}

async fn exec_cmd(Path(id): Path<String>, Json(b): Json<ExecBody>) -> Response {
    let Some(s) = config::find(&id) else {
        return unknown_server();
    };
    let cwd = b
        .cwd
        .filter(|c| !c.is_empty())
        .or_else(|| s.home.clone().filter(|h| !h.is_empty()))
        .unwrap_or_else(|| "/".into());
    let cmd = b.cmd.unwrap_or_default();
    let r = match s.kind.as_str() {
        "wsl" => crate::wsl::exec_cmd(&s, &cwd, &cmd).await,
        "ssh" => ssh::exec_cmd(&s, &cwd, &cmd).await,
        _ => Err("exec not supported for this host".to_string()),
    };
    match r {
        Ok((out, newcwd)) => Json(serde_json::json!({"out": out, "cwd": newcwd})).into_response(),
        Err(e) => Json(serde_json::json!({"out": e, "cwd": cwd, "error": true})).into_response(),
    }
}

async fn static_handler(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".into();
    }
    // Unimplemented API routes must not fall through to index.html (HTTP 200) — that makes
    // the frontend's api() try to JSON.parse HTML. Return a clean 404 instead.
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "endpoint not implemented").into_response();
    }
    if let Some(content) = Assets::get(&path) {
        let mime = mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string();
        return ([(header::CONTENT_TYPE, mime)], content.data.into_owned()).into_response();
    }
    match Assets::get("index.html") {
        Some(c) => (
            [(header::CONTENT_TYPE, "text/html".to_string())],
            c.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
