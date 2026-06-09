//! Synology NAS transport — Synology DSM FileStation web API (ported from connectors.py).
use std::sync::Mutex;

use crate::config::{self, Server};
use crate::ssh::{es, offline, parent_of};

static SID: Mutex<Option<String>> = Mutex::new(None);

fn base() -> Result<String, String> {
    let n = config::get().nas.as_ref().ok_or("no nas config")?;
    Ok(format!("{}://{}:{}/webapi", n.scheme, n.host, n.port))
}

fn coerce_i64(v: &serde_json::Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

async fn login() -> Result<String, String> {
    let n = config::get().nas.as_ref().ok_or("no nas config")?;
    let url = format!("{}/auth.cgi", base()?);
    let r: serde_json::Value = reqwest::Client::new()
        .get(&url)
        .query(&[
            ("api", "SYNO.API.Auth"),
            ("version", "3"),
            ("method", "login"),
            ("account", n.account.as_str()),
            ("passwd", n.passwd.as_str()),
            ("session", "FileStation"),
            ("format", "sid"),
        ])
        .send()
        .await
        .map_err(es)?
        .json()
        .await
        .map_err(es)?;
    if r["success"].as_bool() == Some(true) {
        let sid = r["data"]["sid"]
            .as_str()
            .ok_or("NAS login: no sid")?
            .to_string();
        *SID.lock().unwrap() = Some(sid.clone());
        Ok(sid)
    } else {
        Err(format!("NAS login failed: {}", r["error"]))
    }
}

async fn api_call(
    api: &str,
    method: &str,
    version: &str,
    extra: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    // Clone the cached sid and drop the guard BEFORE any .await (a std Mutex guard held
    // across await makes the future !Send, which axum handlers reject).
    let cached = SID.lock().unwrap().clone();
    let mut sid = match cached {
        Some(s) => s,
        None => login().await?,
    };
    for attempt in 0..2 {
        let url = format!("{}/entry.cgi", base()?);
        let mut q: Vec<(&str, &str)> = vec![
            ("api", api),
            ("version", version),
            ("method", method),
            ("_sid", sid.as_str()),
        ];
        q.extend_from_slice(extra);
        let r: serde_json::Value = reqwest::Client::new()
            .get(&url)
            .query(&q)
            .send()
            .await
            .map_err(es)?
            .json()
            .await
            .map_err(es)?;
        if r["success"].as_bool() == Some(true) {
            return Ok(r["data"].clone());
        }
        let code = r["error"]["code"].as_i64().unwrap_or(0);
        if matches!(code, 105 | 106 | 119) && attempt == 0 {
            sid = login().await?;
            continue;
        }
        return Err(format!("NAS {api}.{method} error: {}", r["error"]));
    }
    Err("NAS API failed".into())
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
                        disks.push(serde_json::json!({"m": "volume", "size": total, "used": total - free}));
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
            &[("folder_path", p.as_str()), ("additional", "[\"size\",\"time\",\"type\"]")],
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
        Err(e) => serde_json::json!({"path": shown, "parent": parent_of(&shown), "entries": [], "error": e}),
    }
}
