//! Synology NAS transport — Synology DSM FileStation web API (ported from connectors.py).
use std::sync::Mutex;

use crate::config::{self, Server};
use crate::ssh::{es, offline, parent_of};

// (base url, sid) of the DSM endpoint that actually answered — probed at login.
static SESSION: Mutex<Option<(String, String)>> = Mutex::new(None);

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
// Each DSM request gets one retry: attempt 0, then a re-login + attempt 1.
const MAX_ATTEMPTS: usize = 2;
// Poll a DSM delete task up to DELETE_POLL_MAX times, DELETE_POLL_INTERVAL apart (~15s budget).
const DELETE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
const DELETE_POLL_MAX: u32 = 30;
// DSM session-expired / invalid-sid error codes that warrant a re-login + retry.
const RELOGIN_CODES: [i64; 3] = [105, 106, 119];

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Candidate DSM base urls: the primary host, then the optional LAN host (NAT hairpin).
fn base_urls() -> Result<Vec<String>, String> {
    let cfg = config::get();
    let nas = cfg.nas.as_ref().ok_or("no nas config")?;
    let mut urls = vec![format!("{}://{}:{}/webapi", nas.scheme, nas.host, nas.port)];
    if let Some(local_host) = &nas.host_local {
        urls.push(format!(
            "{}://{}:{}/webapi",
            nas.scheme, local_host, nas.port
        ));
    }
    Ok(urls)
}

fn coerce_i64(v: &serde_json::Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

async fn login() -> Result<(String, String), String> {
    let cfg = config::get();
    let nas = cfg.nas.as_ref().ok_or("no nas config")?.clone();
    let mut last_error = String::from("no nas endpoints");
    for base in base_urls()? {
        let response: Result<serde_json::Value, String> = async {
            http()
                .get(format!("{base}/auth.cgi"))
                .query(&[
                    ("api", "SYNO.API.Auth"),
                    ("version", "3"),
                    ("method", "login"),
                    ("account", nas.account.as_str()),
                    ("passwd", nas.passwd.as_str()),
                    ("session", "FileStation"),
                    ("format", "sid"),
                ])
                .send()
                .await
                .map_err(es)?
                .json()
                .await
                .map_err(es)
        }
        .await;
        match response {
            Ok(body) if body["success"].as_bool() == Some(true) => {
                let sid = body["data"]["sid"]
                    .as_str()
                    .ok_or("NAS login: no sid")?
                    .to_string();
                *SESSION.lock().unwrap() = Some((base.clone(), sid.clone()));
                return Ok((base, sid));
            }
            Ok(body) => last_error = format!("NAS login failed: {}", body["error"]),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// The active (base url, sid), reusing the cached session or logging in if there is none.
/// Cloning out of the lock in its own statement drops the std Mutex guard before any
/// .await, keeping callers' futures Send (see api_call's comment).
async fn current_session() -> Result<(String, String), String> {
    let cached = SESSION.lock().unwrap().clone();
    match cached {
        Some(s) => Ok(s),
        None => login().await,
    }
}

async fn api_call(
    api: &str,
    method: &str,
    version: &str,
    extra: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    // current_session() drops the std Mutex guard before any .await (a guard held across
    // await makes the future !Send, which axum handlers reject).
    let (mut base, mut sid) = current_session().await?;
    for attempt in 0..MAX_ATTEMPTS {
        let mut query_params: Vec<(&str, &str)> = vec![
            ("api", api),
            ("version", version),
            ("method", method),
            ("_sid", sid.as_str()),
        ];
        query_params.extend_from_slice(extra);
        let resp = http()
            .get(format!("{base}/entry.cgi"))
            .query(&query_params)
            .send()
            .await;
        let body: serde_json::Value = match resp {
            Ok(resp) => resp.json().await.map_err(es)?,
            Err(e) if attempt == 0 => {
                // transport failure (e.g. switched networks) — re-probe endpoints once
                eprintln!("[nas] {e} — re-probing endpoints");
                (base, sid) = login().await?;
                continue;
            }
            Err(e) => return Err(es(e)),
        };
        if body["success"].as_bool() == Some(true) {
            return Ok(body["data"].clone());
        }
        let code = body["error"]["code"].as_i64().unwrap_or(0);
        if RELOGIN_CODES.contains(&code) && attempt == 0 {
            (base, sid) = login().await?;
            continue;
        }
        return Err(format!("NAS {api}.{method} error: {}", body["error"]));
    }
    Err("NAS API failed".into())
}

/// Stream a file off the NAS (DSM FileStation Download). Returns the raw HTTP response.
pub async fn download(path: &str) -> Result<reqwest::Response, String> {
    let (base, sid) = current_session().await?;
    for attempt in 0..MAX_ATTEMPTS {
        let r = http()
            .get(format!("{base}/entry.cgi"))
            .query(&[
                ("api", "SYNO.FileStation.Download"),
                ("version", "2"),
                ("method", "download"),
                ("path", path),
                ("mode", "download"),
                ("_sid", sid.as_str()),
            ])
            .send()
            .await;
        match r {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => return Err(format!("NAS download: HTTP {}", resp.status())),
            Err(e) if attempt == 0 => {
                eprintln!("[nas] {e} — re-probing endpoints");
                login().await?;
            }
            Err(e) => return Err(es(e)),
        }
    }
    Err("NAS download failed".into())
}

/// Upload a stream to a NAS folder (DSM FileStation Upload, multipart).
/// `len` must be known when streaming — DSM rejects chunked transfer-encoding,
/// so without a length the request never completes.
pub async fn upload(
    dir: &str,
    name: &str,
    body: reqwest::Body,
    len: u64,
    overwrite: bool,
) -> Result<(), String> {
    let (base, sid) = current_session().await?;
    let part = reqwest::multipart::Part::stream_with_length(body, len).file_name(name.to_string());
    let form = reqwest::multipart::Form::new()
        .text("api", "SYNO.FileStation.Upload")
        .text("version", "2")
        .text("method", "upload")
        .text("path", dir.to_string())
        .text("create_parents", "true")
        .text("overwrite", if overwrite { "true" } else { "false" })
        .part("file", part);
    // Dedicated client with no timeout: a large streamed upload would blow http()'s 8s budget.
    let r: serde_json::Value = reqwest::Client::builder()
        .build()
        .map_err(es)?
        .post(format!("{base}/entry.cgi"))
        .query(&[("_sid", sid.as_str())])
        .multipart(form)
        .send()
        .await
        .map_err(es)?
        .json()
        .await
        .map_err(es)?;
    if r["success"].as_bool() == Some(true) {
        Ok(())
    } else {
        Err(format!("NAS upload error: {}", r["error"]))
    }
}

pub async fn status(s: &Server) -> serde_json::Value {
    match api_call(
        "SYNO.FileStation.List",
        "list_share",
        "2",
        &[("additional", "[\"volume_status\"]")],
    )
    .await
    {
        Ok(data) => {
            let mut disks = Vec::new();
            if let Some(shares) = data["shares"].as_array() {
                for sh in shares {
                    let vs = &sh["additional"]["volume_status"];
                    let total = coerce_i64(&vs["totalspace"]);
                    if total > 0 {
                        let free = coerce_i64(&vs["freespace"]);
                        disks.push(
                            serde_json::json!({"m": "volume", "size": total, "used": total - free}),
                        );
                        break;
                    }
                }
            }
            serde_json::json!({
                "id": s.id, "online": true, "error": null, "host": "nas", "up": "",
                "load": [0,0,0], "ncpu": 0, "mem": {"total":0,"used":0},
                "disks": disks, "gpus": [], "procs": []
            })
        }
        Err(e) => offline(s, &e),
    }
}

fn split_parent(path: &str) -> Result<(&str, &str), String> {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => Err("path needs a parent folder".into()),
        Some(i) => Ok((&p[..i], &p[i + 1..])),
    }
}

// DSM FileStation treats `path`/`name` as a comma-separated list; a literal comma in a
// filename would split into several targets (e.g. a Delete hitting unintended siblings).
// Wrapping the value in double quotes makes DSM read it as one element.
fn nas_arg(p: &str) -> String {
    if p.contains(',') || p.contains('"') {
        format!("\"{}\"", p.replace('"', "\\\""))
    } else {
        p.to_string()
    }
}

pub async fn fs_op(_s: &Server, op: &str, path: &str, to: Option<&str>) -> Result<(), String> {
    if path.is_empty() || path == "/" {
        return Err("refusing to operate on '/'".into());
    }
    match op {
        "mkdir" => {
            let (parent, name) = split_parent(path)?;
            api_call(
                "SYNO.FileStation.CreateFolder",
                "create",
                "2",
                &[
                    ("folder_path", nas_arg(parent).as_str()),
                    ("name", name),
                    ("force_parent", "false"),
                ],
            )
            .await
            .map(|_| ())
        }
        "touch" => {
            let (parent, name) = split_parent(path)?;
            // DSM's overwrite=false means SKIP (success), so check existence ourselves
            let exists = api_call(
                "SYNO.FileStation.List",
                "getinfo",
                "2",
                &[("path", nas_arg(path).as_str())],
            )
            .await
            .is_ok_and(|d| d["files"][0]["isdir"].is_boolean());
            if exists {
                return Err("already exists".into());
            }
            upload(parent, name, reqwest::Body::from(Vec::new()), 0, false).await
        }
        "rename" => {
            let to = to.ok_or("missing new name")?;
            let (_, new_name) = split_parent(to)?;
            api_call(
                "SYNO.FileStation.Rename",
                "rename",
                "2",
                &[("path", nas_arg(path).as_str()), ("name", new_name)],
            )
            .await
            .map(|_| ())
        }
        "delete" => {
            let data = api_call(
                "SYNO.FileStation.Delete",
                "start",
                "2",
                &[
                    ("path", nas_arg(path).as_str()),
                    ("accurate_progress", "false"),
                ],
            )
            .await?;
            let taskid = data["taskid"].as_str().unwrap_or_default().to_string();
            for _ in 0..DELETE_POLL_MAX {
                tokio::time::sleep(DELETE_POLL_INTERVAL).await;
                // poll version must match the start call (2) — some DSM builds reject v1
                let st = api_call(
                    "SYNO.FileStation.Delete",
                    "status",
                    "2",
                    &[("taskid", taskid.as_str())],
                )
                .await?;
                if st["finished"].as_bool() == Some(true) {
                    return Ok(());
                }
            }
            Err("delete timed out".into())
        }
        _ => Err(format!("unknown op {op}")),
    }
}

pub async fn ls_dir(_s: &Server, path: Option<&str>) -> serde_json::Value {
    let p = path.unwrap_or("").to_string();
    let at_root = p.is_empty() || p == "/" || p == "/.";
    let res: Result<Vec<serde_json::Value>, String> = if at_root {
        api_call("SYNO.FileStation.List", "list_share", "2", &[])
            .await
            .map(|d| {
                d["shares"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|sh| {
                        serde_json::json!({"name": sh["name"], "isdir": true, "islink": false, "size": 0, "mtime": 0})
                    })
                    .collect()
            })
    } else {
        api_call(
            "SYNO.FileStation.List",
            "list",
            "2",
            &[
                ("folder_path", p.as_str()),
                ("additional", "[\"size\",\"time\",\"type\"]"),
            ],
        )
        .await
        .map(|d| {
            d["files"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|f| {
                    let add = &f["additional"];
                    serde_json::json!({
                        "name": f["name"],
                        "isdir": f["isdir"].as_bool().unwrap_or(false),
                        "islink": false,
                        "size": coerce_i64(&add["size"]),
                        "mtime": coerce_i64(&add["time"]["mtime"])
                    })
                })
                .collect()
        })
    };
    let shown = if at_root { "/".to_string() } else { p.clone() };
    match res {
        Ok(entries) => {
            serde_json::json!({"path": shown, "parent": parent_of(&shown), "entries": entries})
        }
        Err(e) => {
            serde_json::json!({"path": shown, "parent": parent_of(&shown), "entries": [], "error": e})
        }
    }
}
