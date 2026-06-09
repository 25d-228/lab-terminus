//! Embedded loopback API server (axum) mirroring the prototype's routes, so the
//! existing web frontend works unchanged.
use axum::{
    extract::{Path, Query},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
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
        .route("/api/servers", get(servers))
        .route("/api/folders", get(folders))
        .route("/api/fleet", get(fleet))
        .route("/api/{id}/status", get(host_status))
        .route("/api/{id}/ls", get(ls))
        .route("/api/{id}/exec", post(exec_cmd))
        .route("/api/{id}/pty", get(crate::pty::pty_handler))
        .fallback(static_handler)
}

fn find(id: &str) -> Option<&'static config::Server> {
    config::get().servers.iter().find(|s| s.id == id)
}

async fn servers() -> impl IntoResponse {
    Json(config::get().servers.clone())
}

async fn folders() -> impl IntoResponse {
    Json(config::get().folders.clone())
}

async fn fleet() -> impl IntoResponse {
    Json(serde_json::json!({ "servers": ssh::fleet().await }))
}

async fn host_status(Path(id): Path<String>) -> Response {
    match find(&id) {
        Some(s) => Json(ssh::status_for(s.clone()).await).into_response(),
        None => (StatusCode::NOT_FOUND, "unknown server").into_response(),
    }
}

#[derive(Deserialize)]
struct LsQuery {
    path: Option<String>,
}

async fn ls(Path(id): Path<String>, Query(q): Query<LsQuery>) -> Response {
    let Some(s) = find(&id) else {
        return (StatusCode::NOT_FOUND, "unknown server").into_response();
    };
    let v = match s.kind.as_str() {
        "wsl" => crate::wsl::ls_dir(s, q.path.as_deref()).await,
        "nas" => crate::nas::ls_dir(s, q.path.as_deref()).await,
        _ => ssh::ls_dir(s, q.path.as_deref()).await,
    };
    Json(v).into_response()
}

#[derive(Deserialize)]
struct ExecBody {
    cwd: Option<String>,
    cmd: Option<String>,
}

async fn exec_cmd(Path(id): Path<String>, Json(b): Json<ExecBody>) -> Response {
    let Some(s) = find(&id) else {
        return (StatusCode::NOT_FOUND, "unknown server").into_response();
    };
    let cwd = b
        .cwd
        .filter(|c| !c.is_empty())
        .or_else(|| s.home.clone().filter(|h| !h.is_empty()))
        .unwrap_or_else(|| "/".into());
    let cmd = b.cmd.unwrap_or_default();
    let r = match s.kind.as_str() {
        "wsl" => crate::wsl::exec_cmd(s, &cwd, &cmd).await,
        "ssh" => ssh::exec_cmd(s, &cwd, &cmd).await,
        _ => Err("exec not supported for this host".to_string()),
    };
    match r {
        Ok((out, newcwd)) => {
            Json(serde_json::json!({"out": out, "cwd": newcwd})).into_response()
        }
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
