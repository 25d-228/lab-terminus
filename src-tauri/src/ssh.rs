//! SSH transport via russh + russh-sftp — ported from the prototype's connectors.py.
//! Provides: fleet/status (one combined GATHER exec, parsed), SFTP directory listing,
//! and command exec with cwd tracking. Connections are per-request for now (a pool comes later).
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::ChannelMsg;

use crate::config::{self, Server};

// ---- one round trip per host gathers everything the Monitor needs ----
pub(crate) const GATHER: &str = r#"echo '@@HOST'; hostname
echo '@@UP'; awk '{print int($1)}' /proc/uptime
echo '@@LOAD'; cat /proc/loadavg
echo '@@NCPU'; nproc
echo '@@MEM'; free -b | awk 'NR==2{print $2, $3}'
echo '@@DF'; df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs --output=target,size,used 2>/dev/null | tail -n +2
echo '@@GPU'; nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null
echo '@@APPS'; nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits 2>/dev/null
PIDS=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr -d ' ' | sort -u | paste -sd, -)
echo '@@PS'; if [ -n "$PIDS" ]; then ps -o pid= -o user:32= -o etimes= -o args= -p "$PIDS" 2>/dev/null; fi
echo '@@END'"#;

pub(crate) fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// Bound every SSH op so one dead/slow host can't hang a request (the prototype used timeout=8).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const EXEC_TIMEOUT: Duration = Duration::from_secs(25);

pub(crate) struct Client;

impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
        // Trust-on-first-use (the prototype used AutoAddPolicy). Host-key pinning is a later hardening step.
        Ok(true)
    }
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(Into::into)
}

fn key_path() -> std::path::PathBuf {
    let p = config::get()
        .key
        .clone()
        .unwrap_or_else(|| "~/.ssh/id_ed25519".into());
    if let Some(rest) = p.strip_prefix('~') {
        if let Some(home) = home_dir() {
            return home.join(rest.trim_start_matches(['/', '\\']));
        }
    }
    std::path::PathBuf::from(p)
}

pub(crate) async fn connect(s: &Server) -> Result<Handle<Client>, String> {
    // one retry ONLY for a genuine transient (sshd throttling drops the handshake).
    // Never retry a plain timeout — that just doubles the stall on an unreachable host,
    // which (×6 NAT-unreachable duplicates) is what gates the whole fleet scan.
    match connect_once(s).await {
        Ok(h) => Ok(h),
        Err(e) if e.contains("timed out") => Err(e),
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(400)).await;
            connect_once(s).await
        }
    }
}

async fn connect_once(s: &Server) -> Result<Handle<Client>, String> {
    let host = s.host.clone().ok_or("no host")?;
    let port = s.port.unwrap_or(22);
    let user = s.user.clone().ok_or("no user")?;
    let key = load_secret_key(key_path(), None).map_err(|e| format!("key: {e}"))?;
    let cfg = Arc::new(client::Config::default());
    let mut handle = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(cfg, (host.as_str(), port), Client),
    )
    .await
    .map_err(|_| "connect: timed out".to_string())?
    .map_err(|e| format!("connect: {e}"))?;
    let auth = tokio::time::timeout(
        CONNECT_TIMEOUT,
        handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), None)),
    )
    .await
    .map_err(|_| "auth: timed out".to_string())?
    .map_err(|e| format!("auth: {e}"))?;
    if !auth.success() {
        return Err("authentication failed".into());
    }
    Ok(handle)
}

async fn exec_raw(handle: &Handle<Client>, cmd: &str) -> Result<String, String> {
    let mut ch = handle.channel_open_session().await.map_err(es)?;
    ch.exec(true, cmd).await.map_err(es)?;
    let read = async move {
        let mut out: Vec<u8> = Vec::new();
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Data { ref data }) => out.extend_from_slice(&data[..]),
                Some(ChannelMsg::ExtendedData { ref data, .. }) => out.extend_from_slice(&data[..]),
                Some(_) => {}
                None => break,
            }
        }
        out
    };
    match tokio::time::timeout(EXEC_TIMEOUT, read).await {
        Ok(out) => Ok(String::from_utf8_lossy(&out).into_owned()),
        Err(_) => Err("command timed out".into()),
    }
}

// Like exec_raw but keeps stdout/stderr separate and returns the exit code, so callers
// can judge success by status instead of scraping a sentinel string out of merged output.
async fn exec_status(handle: &Handle<Client>, cmd: &str) -> Result<(u32, String, String), String> {
    let mut ch = handle.channel_open_session().await.map_err(es)?;
    ch.exec(true, cmd).await.map_err(es)?;
    let read = async move {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut code: u32 = 0;
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Data { ref data }) => out.extend_from_slice(&data[..]),
                Some(ChannelMsg::ExtendedData { ref data, .. }) => err.extend_from_slice(&data[..]),
                Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status,
                Some(_) => {}
                None => break,
            }
        }
        (
            code,
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
        )
    };
    match tokio::time::timeout(EXEC_TIMEOUT, read).await {
        Ok(t) => Ok(t),
        Err(_) => Err("command timed out".into()),
    }
}

// ---------------------------------------------------------------- gather parsing
fn fmt_dur(sec: i64) -> String {
    let (d, h, m) = (sec / 86400, (sec % 86400) / 3600, (sec % 3600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

fn next_token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    match s.find(char::is_whitespace) {
        Some(i) => Some((&s[..i], &s[i..])),
        None => Some((s, "")),
    }
}

pub(crate) fn parse_gather(text: &str) -> serde_json::Value {
    let mut sec: HashMap<String, Vec<String>> = HashMap::new();
    let mut cur: Option<String> = None;
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            let name = name.trim().to_string();
            cur = Some(name.clone());
            sec.entry(name).or_default();
        } else if let Some(c) = &cur {
            sec.get_mut(c).unwrap().push(line.to_string());
        }
    }
    let get = |k: &str| sec.get(k).cloned().unwrap_or_default();
    let first = |k: &str| get(k).first().cloned().unwrap_or_default();

    let host = first("HOST").trim().to_string();
    let up = first("UP")
        .trim()
        .parse::<i64>()
        .map(fmt_dur)
        .unwrap_or_default();
    let load: Vec<f64> = {
        let parts: Vec<f64> = first("LOAD")
            .split_whitespace()
            .take(3)
            .filter_map(|x| x.parse().ok())
            .collect();
        if parts.len() == 3 {
            parts
        } else {
            vec![0.0, 0.0, 0.0]
        }
    };
    let ncpu = first("NCPU").trim().parse::<i64>().unwrap_or(0);
    let mem = {
        let p: Vec<i64> = first("MEM")
            .split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect();
        if p.len() == 2 {
            serde_json::json!({"total": p[0], "used": p[1]})
        } else {
            serde_json::json!({"total": 0, "used": 0})
        }
    };
    let mut disks = Vec::new();
    for ln in get("DF") {
        let p: Vec<&str> = ln.split_whitespace().collect();
        if p.len() >= 3 {
            if let (Ok(sz), Ok(us)) = (p[1].parse::<i64>(), p[2].parse::<i64>()) {
                disks.push(serde_json::json!({"m": p[0], "size": sz, "used": us}));
            }
        }
    }
    let numf = |s: &str| s.parse::<f64>().unwrap_or(0.0);
    let mut gpus = Vec::new();
    let mut uuidmap: HashMap<String, i64> = HashMap::new();
    for ln in get("GPU") {
        let c: Vec<String> = ln.split(',').map(|x| x.trim().to_string()).collect();
        if c.len() >= 9 {
            if let Ok(idx) = c[0].parse::<i64>() {
                uuidmap.insert(c[1].clone(), idx);
                gpus.push(serde_json::json!({
                    "index": idx, "name": c[2],
                    "mu": numf(&c[3]) as i64, "mt": numf(&c[4]) as i64,
                    "util": numf(&c[5]) as i64, "temp": numf(&c[6]) as i64,
                    "pow": numf(&c[7]), "plim": numf(&c[8]) as i64
                }));
            }
        }
    }
    let mut apps: Vec<(i64, String, i64)> = Vec::new();
    for ln in get("APPS") {
        let c: Vec<String> = ln.split(',').map(|x| x.trim().to_string()).collect();
        if c.len() >= 3 {
            if let Ok(pid) = c[0].parse::<i64>() {
                apps.push((pid, c[1].clone(), numf(&c[2]) as i64));
            }
        }
    }
    let mut psmap: HashMap<i64, (String, String, String)> = HashMap::new();
    for ln in get("PS") {
        if let Some((pid_s, r)) = next_token(&ln) {
            if let Some((user, r)) = next_token(r) {
                if let Some((etime, r)) = next_token(r) {
                    if let Ok(pid) = pid_s.parse::<i64>() {
                        let etime = etime
                            .parse::<i64>()
                            .map(fmt_dur)
                            .unwrap_or_else(|_| etime.to_string());
                        psmap.insert(pid, (user.to_string(), etime, r.trim_start().to_string()));
                    }
                }
            }
        }
    }
    let procs: Vec<serde_json::Value> = apps
        .iter()
        .map(|(pid, uuid, mem)| {
            let (user, etime, cmd) = psmap
                .get(pid)
                .cloned()
                .unwrap_or_else(|| ("?".into(), String::new(), String::new()));
            serde_json::json!({
                "pid": pid, "gpu": uuidmap.get(uuid).copied().unwrap_or(0),
                "mem": mem, "user": user, "etime": etime, "cmd": cmd
            })
        })
        .collect();

    serde_json::json!({
        "host": host, "up": up, "ncpu": ncpu, "load": load,
        "mem": mem, "disks": disks, "gpus": gpus, "procs": procs
    })
}

pub(crate) fn offline(s: &Server, err: &str) -> serde_json::Value {
    serde_json::json!({
        "id": s.id, "online": false, "error": err, "host": "", "up": "",
        "load": [0,0,0], "ncpu": 0, "mem": {"total":0,"used":0},
        "disks": [], "gpus": [], "procs": []
    })
}

// ---------------------------------------------------------------- status / fleet
pub async fn status_for(s: Server) -> serde_json::Value {
    match s.kind.as_str() {
        "wsl" => return crate::wsl::status(&s).await,
        "nas" => return crate::nas::status(&s).await,
        "ssh" => {}
        _ => return offline(&s, "unsupported host kind"),
    }
    match async {
        let handle = connect(&s).await?;
        exec_raw(&handle, GATHER).await
    }
    .await
    {
        Ok(out) => {
            let mut g = parse_gather(&out);
            g["id"] = s.id.clone().into();
            g["online"] = true.into();
            g["error"] = serde_json::Value::Null;
            g
        }
        Err(e) => offline(&s, &e),
    }
}

static FLEET_CACHE: Mutex<Option<(Instant, Vec<serde_json::Value>)>> = Mutex::new(None);
// single-flight guard: only ONE fleet scan may run at a time. Overlapping polls return
// the cached snapshot instead of each launching a fresh set of SSH connects — that pile-up
// (slowest host gates a ~16s scan, frontend polls every 5s) is what stormed the sshds and
// made healthy servers flap offline/online.
static FLEET_REFRESHING: AtomicBool = AtomicBool::new(false);
const FLEET_TTL: Duration = Duration::from_secs(3);

// One concurrent scan of every configured host (reachable + unreachable).
async fn fleet_scan() -> Vec<serde_json::Value> {
    let servers = config::get().servers.clone();
    let n = servers.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, s) in servers.into_iter().enumerate() {
        set.spawn(async move { (i, status_for(s).await) });
    }
    let mut out: Vec<serde_json::Value> = vec![serde_json::Value::Null; n];
    while let Some(res) = set.join_next().await {
        if let Ok((i, v)) = res {
            out[i] = v;
        }
    }
    out
}

pub async fn fleet() -> Vec<serde_json::Value> {
    let snapshot = FLEET_CACHE.lock().ok().and_then(|g| g.clone());
    if let Some((t, data)) = &snapshot {
        if t.elapsed() < FLEET_TTL {
            return data.clone(); // fresh enough
        }
    }
    // Stale or empty. Try to claim the single scan slot; if someone else owns it, serve the
    // last snapshot (stale-while-revalidate) rather than starting a competing scan.
    if FLEET_REFRESHING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return snapshot.map(|(_, d)| d).unwrap_or_default();
    }
    match snapshot {
        Some((_, data)) => {
            // Have stale data: refresh in the background and return the stale snapshot now,
            // so the HTTP handler never blocks for the ~8s a scan takes.
            tokio::spawn(async move {
                let fresh = fleet_scan().await;
                if let Ok(mut g) = FLEET_CACHE.lock() {
                    *g = Some((Instant::now(), fresh));
                }
                FLEET_REFRESHING.store(false, Ordering::Release);
            });
            data
        }
        None => {
            // First call ever — compute synchronously, then release the slot.
            let fresh = fleet_scan().await;
            if let Ok(mut g) = FLEET_CACHE.lock() {
                *g = Some((Instant::now(), fresh.clone()));
            }
            FLEET_REFRESHING.store(false, Ordering::Release);
            fresh
        }
    }
}

// ---------------------------------------------------------------- explorer (sftp)
pub(crate) fn parent_of(p: &str) -> String {
    if p.is_empty() || p == "/" {
        return "/".into();
    }
    let q = p.trim_end_matches('/');
    match q.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => q[..i].to_string(),
        None => "/".into(),
    }
}

async fn ls_inner(s: &Server, path: Option<&str>) -> Result<serde_json::Value, String> {
    let handle = connect(s).await?;
    let ch = handle.channel_open_session().await.map_err(es)?;
    ch.request_subsystem(true, "sftp").await.map_err(es)?;
    let sftp = russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .map_err(es)?;
    let path = match path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => sftp.canonicalize(".").await.map_err(es)?,
    };
    let rd = sftp.read_dir(&path).await.map_err(es)?;
    let base = path.trim_end_matches('/');
    let mut entries = Vec::new();
    for entry in rd {
        let name = entry.file_name();
        let meta = entry.metadata();
        let islink = meta.is_symlink();
        let mut isdir = meta.is_dir();
        if islink {
            if let Ok(t) = sftp.metadata(format!("{base}/{name}")).await {
                isdir = t.is_dir();
            }
        }
        entries.push(serde_json::json!({
            "name": name, "isdir": isdir, "islink": islink,
            "size": meta.size.unwrap_or(0), "mtime": meta.mtime.unwrap_or(0)
        }));
    }
    Ok(serde_json::json!({"path": path, "parent": parent_of(&path), "entries": entries}))
}

pub async fn ls_dir(s: &Server, path: Option<&str>) -> serde_json::Value {
    match ls_inner(s, path).await {
        Ok(v) => v,
        Err(e) => {
            let p = path.unwrap_or("/").to_string();
            serde_json::json!({"path": p, "parent": parent_of(&p), "entries": [], "error": e})
        }
    }
}

// ---------------------------------------------------------------- fs ops (Explorer CRUD)
pub async fn fs_op(s: &Server, op: &str, path: &str, to: Option<&str>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    if path.is_empty() || path == "/" {
        return Err("refusing to operate on '/'".into());
    }
    let handle = connect(s).await?;
    let ch = handle.channel_open_session().await.map_err(es)?;
    ch.request_subsystem(true, "sftp").await.map_err(es)?;
    let sftp = russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .map_err(es)?;
    match op {
        "mkdir" => {
            // symlink_metadata (LSTAT) so an existing symlink/file is caught too
            if sftp.symlink_metadata(path).await.is_ok() {
                return Err("already exists".into());
            }
            sftp.create_dir(path).await.map_err(es)
        }
        "touch" => {
            if sftp.symlink_metadata(path).await.is_ok() {
                return Err("already exists".into());
            }
            let mut f = sftp.create(path).await.map_err(es)?;
            f.shutdown().await.map_err(es)
        }
        "rename" => {
            let to = to.ok_or("missing new name")?;
            if sftp.symlink_metadata(to).await.is_ok() {
                return Err("target already exists".into());
            }
            sftp.rename(path, to).await.map_err(es)
        }
        "delete" => {
            // LSTAT, not STAT: a dangling symlink (which the listing shows) must be
            // removable, and a symlink-to-dir must be unlinked, not recursed into.
            let meta = sftp
                .symlink_metadata(path)
                .await
                .map_err(|_| "no such file".to_string())?;
            if meta.is_dir() {
                // recursive delete in one round trip; success judged by exit status,
                // not a sentinel (rm's stderr could otherwise contain the marker text).
                let (code, _out, err) =
                    exec_status(&handle, &format!("rm -rf -- {}", shell_quote(path))).await?;
                if code == 0 {
                    Ok(())
                } else if err.trim().is_empty() {
                    Err(format!("delete failed (exit {code})"))
                } else {
                    Err(err.trim().to_string())
                }
            } else {
                sftp.remove_file(path).await.map_err(es)
            }
        }
        _ => Err(format!("unknown op {op}")),
    }
}

// ---------------------------------------------------------------- terminal (exec with cwd)
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) fn split_cwd(out: &str, cwd: &str) -> (String, String) {
    if let Some(i) = out.rfind("@@CWD@@") {
        let text = out[..i].trim_end_matches('\n').to_string();
        let newcwd = out[i + 7..].trim().to_string();
        (text, if newcwd.is_empty() { cwd.to_string() } else { newcwd })
    } else {
        (out.to_string(), cwd.to_string())
    }
}

pub async fn exec_cmd(s: &Server, cwd: &str, cmd: &str) -> Result<(String, String), String> {
    let full = format!(
        "cd {} 2>/dev/null\n{}\nprintf '\\n@@CWD@@%s' \"$(pwd)\"",
        shell_quote(cwd),
        cmd
    );
    let handle = connect(s).await?;
    let out = exec_raw(&handle, &full).await?;
    Ok(split_cwd(&out, cwd))
}
