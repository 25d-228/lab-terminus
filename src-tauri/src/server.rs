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
use serde::{Deserialize, Serialize};

use crate::status::HostStatus;
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
        .route(
            "/api/preferences/overview-group",
            get(overview_group_get).put(overview_group_put),
        )
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

#[derive(Serialize)]
struct OverviewGroupPreference {
    group: Option<String>,
}

async fn overview_group_get() -> impl IntoResponse {
    Json(OverviewGroupPreference {
        group: config::get().overview_group.clone(),
    })
}

fn overview_group_update(
    body: &serde_json::Value,
    folders: &[config::Folder],
) -> Result<Option<String>, String> {
    let group = match body.get("group") {
        Some(serde_json::Value::Null) => return Ok(None),
        Some(serde_json::Value::String(group)) => group,
        _ => return Err("group must be a folder key or null".into()),
    };
    if !folders.iter().any(|folder| folder.key == *group) {
        return Err("unknown folder".into());
    }
    Ok(Some(group.clone()))
}

async fn overview_group_put(Json(body): Json<serde_json::Value>) -> Response {
    let snapshot = config::get();
    let group = match overview_group_update(&body, &snapshot.folders) {
        Ok(group) => group,
        Err(error) => return err400(error),
    };
    match config::set_overview_group(group) {
        Ok(group) => Json(OverviewGroupPreference { group }).into_response(),
        Err(error) => err400(error),
    }
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

#[derive(Serialize)]
struct FleetResponse {
    servers: Vec<Option<HostStatus>>,
    rev: u64,
}

async fn fleet() -> impl IntoResponse {
    Json(FleetResponse {
        servers: ssh::fleet().await,
        rev: config::rev(),
    })
}

#[derive(Deserialize)]
struct StatusQuery {
    #[serde(default)]
    process_scope: ssh::ProcessScope,
}

async fn host_status(Path(id): Path<String>, Query(q): Query<StatusQuery>) -> Response {
    let Some(s) = config::find(&id) else {
        return unknown_server();
    };
    Json(ssh::status_for(s, q.process_scope).await).into_response()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn extract_status_query(uri: &str) -> StatusQuery {
        let uri: Uri = uri.parse().expect("test URI should be valid");
        let Query(query) =
            Query::<StatusQuery>::try_from_uri(&uri).expect("query should be accepted by Axum");
        query
    }

    #[test]
    fn axum_query_extraction_defaults_an_omitted_scope_to_mine() {
        let query = extract_status_query("/api/host-1/status");

        assert_eq!(query.process_scope, ssh::ProcessScope::Mine);
    }

    #[test]
    fn axum_query_extraction_accepts_each_supported_scope() {
        for (value, expected) in [
            ("mine", ssh::ProcessScope::Mine),
            ("others", ssh::ProcessScope::Others),
            ("root", ssh::ProcessScope::Root),
        ] {
            let query = extract_status_query(&format!("/api/host-1/status?process_scope={value}"));

            assert_eq!(query.process_scope, expected);
        }
    }

    #[test]
    fn axum_rejects_an_unsupported_scope_before_the_handler_can_run() {
        let uri: Uri = "/api/host-1/status?process_scope=all"
            .parse()
            .expect("test URI should be valid");
        let Err(rejection) = Query::<StatusQuery>::try_from_uri(&uri) else {
            panic!("an unsupported scope should be rejected by Axum");
        };

        assert_eq!(rejection.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn overview_group_update_accepts_valid_values_and_rejects_unknown_keys() {
        let folders = vec![config::Folder {
            key: "lab".into(),
            title: "Lab Servers".into(),
            custom: None,
            extra: Default::default(),
        }];

        assert_eq!(
            overview_group_update(&serde_json::json!({"group": null}), &folders),
            Ok(None)
        );
        assert_eq!(
            overview_group_update(&serde_json::json!({"group": "lab"}), &folders),
            Ok(Some("lab".into()))
        );
        let error = overview_group_update(&serde_json::json!({"group": "missing"}), &folders)
            .expect_err("unknown key should be rejected");
        assert_eq!(err400(error).status(), StatusCode::BAD_REQUEST);
    }
}
