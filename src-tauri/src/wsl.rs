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

// run() but surfacing the exit code and stderr — fs ops judge success by status, not
// a stdout sentinel, and need the real diagnostic when something fails.
async fn run_status(cmd: &str) -> Result<(i32, String, String), String> {
    let out = tokio::process::Command::new("wsl.exe")
        .args(["-d", &distro(), "--", "bash", "-lc", cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| format!("wsl.exe: {e}"))?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
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

pub async fn ls_dir(_s: &Server, path: Option<&str>) -> serde_json::Value {
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
    // NUL-terminated records + at-most-4-way split: filenames containing tabs or
    // newlines stay intact (the name is the final field, so embedded tabs survive).
    let cmd = format!(
        "LANG=C find {} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'",
        ssh::shell_quote(&p)
    );
    match run(&cmd).await {
        Ok(out) => {
            let mut entries = Vec::new();
            for rec in out.split('\0') {
                if rec.is_empty() {
                    continue;
                }
                let c: Vec<&str> = rec.splitn(4, '\t').collect();
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

pub async fn fs_op(_s: &Server, op: &str, path: &str, to: Option<&str>) -> Result<(), String> {
    if path.is_empty() || path == "/" {
        return Err("refusing to operate on '/'".into());
    }
    let q = ssh::shell_quote(path);
    // exit 17 == EEXIST, our "already exists" signal; any other nonzero is a real failure
    // whose stderr we surface verbatim. No -p on mkdir, so an existing name errors cleanly.
    let cmd = match op {
        "mkdir" => format!("if [ -e {q} ]; then exit 17; fi; mkdir -- {q}"),
        "touch" => format!("if [ -e {q} ]; then exit 17; fi; touch -- {q}"),
        "rename" => {
            let t = ssh::shell_quote(to.ok_or("missing new name")?);
            format!("if [ -e {t} ]; then exit 17; fi; mv -- {q} {t}")
        }
        "delete" => format!("rm -rf -- {q}"),
        _ => return Err(format!("unknown op {op}")),
    };
    let (code, _out, err) = run_status(&cmd).await?;
    match code {
        0 => Ok(()),
        17 => Err("already exists".into()),
        _ if err.trim().is_empty() => Err(format!("failed (exit {code})")),
        _ => Err(err.trim().to_string()),
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
