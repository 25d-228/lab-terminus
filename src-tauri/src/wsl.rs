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
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Shell exit code 17 == EEXIST: an fs op's "already exists" signal. Any other nonzero is a
// real failure whose stderr we surface verbatim.
const ALREADY_EXISTS_CODE: i32 = 17;

// creation_flags only exists on Windows; elsewhere wsl.exe is simply absent and the
// spawn error surfaces as the host being offline.
fn wsl_command(cmd: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("wsl.exe");
    command.args(["-d", &distro(), "--", "bash", "-lc", cmd]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

async fn run(cmd: &str) -> Result<String, String> {
    let out = wsl_command(cmd)
        .output()
        .await
        .map_err(|e| format!("wsl.exe: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// run() but surfacing the exit code and stderr — fs ops judge success by status, not
// a stdout sentinel, and need the real diagnostic when something fails.
async fn run_status(cmd: &str) -> Result<(i32, String, String), String> {
    let out = wsl_command(cmd)
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
        Ok(out) => ssh::online(s, &out),
        Err(e) => ssh::offline(s, &e),
    }
}

// Resolve the WSL user's $HOME, falling back to "/" when it is unset or empty.
async fn home_dir() -> String {
    let home = run("printf %s \"$HOME\"").await.unwrap_or_default();
    let home = home.trim();
    if home.is_empty() {
        return "/".into();
    }
    home.to_string()
}

pub async fn ls_dir(_s: &Server, path: Option<&str>) -> serde_json::Value {
    let p = match path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => home_dir().await,
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
            for record in out.split('\0') {
                if record.is_empty() {
                    continue;
                }
                // fields: type(%y), size(%s), mtime(%T@), name(%f) — name is last so embedded
                // tabs in it survive the at-most-4-way split.
                let fields: Vec<&str> = record.splitn(4, '\t').collect();
                if fields.len() >= 4 {
                    entries.push(serde_json::json!({
                        "name": fields[3],
                        "isdir": fields[0] == "d",
                        "islink": fields[0] == "l",
                        "size": fields[1].parse::<i64>().unwrap_or(0),
                        "mtime": fields[2].parse::<f64>().unwrap_or(0.0) as i64
                    }));
                }
            }
            serde_json::json!({"path": p, "parent": ssh::parent_of(&p), "entries": entries})
        }
        Err(e) => {
            serde_json::json!({"path": p, "parent": ssh::parent_of(&p), "entries": [], "error": e})
        }
    }
}

pub async fn fs_op(_s: &Server, op: &str, path: &str, to: Option<&str>) -> Result<(), String> {
    if path.is_empty() || path == "/" {
        return Err("refusing to operate on '/'".into());
    }
    let quoted_path = ssh::shell_quote(path);
    // No -p on mkdir, so an existing name errors cleanly via the ALREADY_EXISTS_CODE guard.
    let cmd = match op {
        "mkdir" => {
            format!("if [ -e {quoted_path} ]; then exit {ALREADY_EXISTS_CODE}; fi; mkdir -- {quoted_path}")
        }
        "touch" => {
            format!("if [ -e {quoted_path} ]; then exit {ALREADY_EXISTS_CODE}; fi; touch -- {quoted_path}")
        }
        "rename" => {
            let quoted_target = ssh::shell_quote(to.ok_or("missing new name")?);
            format!("if [ -e {quoted_target} ]; then exit {ALREADY_EXISTS_CODE}; fi; mv -- {quoted_path} {quoted_target}")
        }
        "delete" => format!("rm -rf -- {quoted_path}"),
        _ => return Err(format!("unknown op {op}")),
    };
    let (code, _out, err) = run_status(&cmd).await?;
    match code {
        0 => Ok(()),
        ALREADY_EXISTS_CODE => Err("already exists".into()),
        _ if err.trim().is_empty() => Err(format!("failed (exit {code})")),
        _ => Err(err.trim().to_string()),
    }
}

pub async fn exec_cmd(_s: &Server, cwd: &str, cmd: &str) -> Result<(String, String), String> {
    let full = format!(
        "cd {} 2>/dev/null; {}; printf '\\n{}%s' \"$(pwd)\"",
        ssh::shell_quote(cwd),
        cmd,
        ssh::CWD_MARKER
    );
    let out = run(&full).await?;
    Ok(ssh::split_cwd(&out, cwd))
}
