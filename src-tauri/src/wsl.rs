//! WSL transport — runs commands inside the WSL distro via wsl.exe (ported from the prototype).
use crate::config::{self, Server};
use crate::ssh;

fn distro() -> String {
    config::get()
        .wsl
        .as_ref()
        .and_then(|w| w.distro.clone())
        .unwrap_or_else(|| "Ubuntu".into())
}

// CREATE_NO_WINDOW: keep wsl.exe from flashing a console window on every call.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

async fn run(cmd: &str) -> Result<String, String> {
    let out = tokio::process::Command::new("wsl.exe")
        .args(["-d", &distro(), "--", "bash", "-lc", cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| format!("wsl.exe: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn status(s: &Server) -> serde_json::Value {
    match run(ssh::GATHER).await {
        Ok(out) => {
            let mut g = ssh::parse_gather(&out);
            g["id"] = s.id.clone().into();
            g["online"] = true.into();
            g["error"] = serde_json::Value::Null;
            g
        }
        Err(e) => ssh::offline(s, &e),
    }
}

pub async fn ls_dir(s: &Server, path: Option<&str>) -> serde_json::Value {
    let p = match path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => {
            let h = run("printf %s \"$HOME\"").await.unwrap_or_default();
            let h = h.trim().to_string();
            if h.is_empty() {
                "/".into()
            } else {
                h
            }
        }
    };
    let cmd = format!(
        "LANG=C find {} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'",
        ssh::shell_quote(&p)
    );
    match run(&cmd).await {
        Ok(out) => {
            let mut entries = Vec::new();
            for ln in out.lines() {
                let c: Vec<&str> = ln.split('\t').collect();
                if c.len() >= 4 {
                    entries.push(serde_json::json!({
                        "name": c[3],
                        "isdir": c[0] == "d",
                        "islink": c[0] == "l",
                        "size": c[1].parse::<i64>().unwrap_or(0),
                        "mtime": c[2].parse::<f64>().unwrap_or(0.0) as i64
                    }));
                }
            }
            serde_json::json!({"path": p, "parent": ssh::parent_of(&p), "entries": entries})
        }
        Err(e) => serde_json::json!({"path": p, "parent": ssh::parent_of(&p), "entries": [], "error": e}),
    }
}

pub async fn exec_cmd(_s: &Server, cwd: &str, cmd: &str) -> Result<(String, String), String> {
    let full = format!(
        "cd {} 2>/dev/null; {}; printf '\\n@@CWD@@%s' \"$(pwd)\"",
        ssh::shell_quote(cwd),
        cmd
    );
    let out = run(&full).await?;
    Ok(ssh::split_cwd(&out, cwd))
}
