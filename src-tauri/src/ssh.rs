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
use serde::Deserialize;

use crate::config::{self, Server};
use crate::status::{
    DiskStatus, GpuProcessStatus, GpuStatus, HostStatus, MemoryStatus, NetworkStatus,
    TopProcessStatus,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProcessScope {
    #[default]
    Mine,
    Others,
    Root,
}

impl ProcessScope {
    fn row_limit(self) -> usize {
        match self {
            Self::Mine => 20,
            Self::Others | Self::Root => 50,
        }
    }
}

// ---- one round trip per host gathers everything the Monitor needs ----
const GATHER_BEFORE_TOP: &str = r#"echo '@@HOST'; hostname
echo '@@UP'; awk '{print int($1)}' /proc/uptime
echo '@@LOAD'; cat /proc/loadavg
echo '@@NCPU'; nproc
echo '@@MEM'; free -b | awk 'NR==2{print $2, $3}'
echo '@@DF'; df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs --output=target,size,used 2>/dev/null | tail -n +2
echo '@@NET'; cat /proc/net/dev 2>/dev/null
echo '@@TOP'; "#;

const MINE_TOP: &str = r#"EFFECTIVE_UID=$(id -u); LC_ALL=C ps ww -eo uid=,pid=,user:32=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu,-rss 2>/dev/null | awk -v uid="$EFFECTIVE_UID" '$1 == uid { sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, ""); print }' | head -n 20"#;
const OTHERS_TOP: &str = r#"EFFECTIVE_UID=$(id -u); LC_ALL=C ps ww -eo uid=,pid=,user:32=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu,-rss 2>/dev/null | awk -v uid="$EFFECTIVE_UID" '$1 != uid && $1 != 0 { sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, ""); print }' | head -n 50"#;
const ROOT_TOP: &str = r#"LC_ALL=C ps ww -eo uid=,pid=,user:32=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu,-rss 2>/dev/null | awk '$1 == 0 { sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, ""); print }' | head -n 50"#;

const GATHER_AFTER_TOP: &str = r#"
echo '@@GPU'; nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null
echo '@@APPS'; nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits 2>/dev/null
PIDS=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr -d ' ' | sort -u | paste -sd, -)
echo '@@PS'; if [ -n "$PIDS" ]; then ps -o pid= -o user:32= -o etimes= -o args= -p "$PIDS" 2>/dev/null; fi
echo '@@END'"#;

pub(crate) fn gather_command(process_scope: ProcessScope) -> String {
    let top = match process_scope {
        ProcessScope::Mine => MINE_TOP,
        ProcessScope::Others => OTHERS_TOP,
        ProcessScope::Root => ROOT_TOP,
    };
    [GATHER_BEFORE_TOP, top, GATHER_AFTER_TOP].concat()
}

pub(crate) fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// Bound every SSH op so one dead/slow host can't hang a request (the prototype used timeout=8).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const EXEC_TIMEOUT: Duration = Duration::from_secs(25);

// Marker printed after a command's output so exec_cmd can recover the shell's resulting cwd
// (the `cd` may have moved it). Shared with the WSL backend, which runs the same protocol.
pub(crate) const CWD_MARKER: &str = "@@CWD@@";

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

fn parse_f64_or_zero(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(0.0)
}

fn parse_disks(lines: &[String]) -> Vec<DiskStatus> {
    let mut disks = Vec::new();
    for line in lines {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        if let (Ok(size), Ok(used)) = (fields[1].parse::<i64>(), fields[2].parse::<i64>()) {
            disks.push(DiskStatus {
                m: fields[0].to_string(),
                size,
                used,
            });
        }
    }
    disks
}

fn parse_network(lines: &[String], uptime_seconds: Option<u64>) -> NetworkStatus {
    let Some(uptime_seconds) = uptime_seconds else {
        return NetworkStatus::default();
    };
    let mut rx_bytes = 0_u64;
    let mut tx_bytes = 0_u64;
    let mut seen = false;
    for line in lines {
        let Some((interface, counters)) = line.split_once(':') else {
            continue;
        };
        if interface.trim() == "lo" {
            continue;
        }
        let fields: Vec<&str> = counters.split_whitespace().collect();
        if fields.len() < 9 {
            return NetworkStatus::default();
        }
        let (Ok(rx), Ok(tx)) = (fields[0].parse::<u64>(), fields[8].parse::<u64>()) else {
            return NetworkStatus::default();
        };
        let Some(next_rx) = rx_bytes.checked_add(rx) else {
            return NetworkStatus::default();
        };
        let Some(next_tx) = tx_bytes.checked_add(tx) else {
            return NetworkStatus::default();
        };
        rx_bytes = next_rx;
        tx_bytes = next_tx;
        seen = true;
    }
    NetworkStatus {
        available: seen,
        rx_bytes,
        tx_bytes,
        uptime_seconds,
    }
}

fn parse_top_processes(lines: &[String], limit: usize) -> Vec<TopProcessStatus> {
    let mut processes = Vec::new();
    for line in lines {
        let Some((pid, rest)) = next_token(line) else {
            continue;
        };
        let Some((user, rest)) = next_token(rest) else {
            continue;
        };
        let Some((cpu_pct, rest)) = next_token(rest) else {
            continue;
        };
        let Some((memory_pct, rest)) = next_token(rest) else {
            continue;
        };
        let Some((resident_kib, rest)) = next_token(rest) else {
            continue;
        };
        let Some((elapsed_seconds, command)) = next_token(rest) else {
            continue;
        };
        let (Ok(pid), Ok(cpu_pct), Ok(memory_pct), Ok(resident_kib), Ok(elapsed_seconds)) = (
            pid.parse::<i64>(),
            cpu_pct.parse::<f64>(),
            memory_pct.parse::<f64>(),
            resident_kib.parse::<u64>(),
            elapsed_seconds.parse::<i64>(),
        ) else {
            continue;
        };
        let Some(resident_bytes) = resident_kib.checked_mul(1024) else {
            continue;
        };
        let command = command.trim_start();
        if pid <= 0
            || !cpu_pct.is_finite()
            || cpu_pct < 0.0
            || !memory_pct.is_finite()
            || memory_pct < 0.0
            || elapsed_seconds < 0
            || command.is_empty()
        {
            continue;
        }
        processes.push(TopProcessStatus {
            pid,
            user: user.to_string(),
            cpu_pct,
            memory_pct,
            resident_bytes,
            elapsed: fmt_dur(elapsed_seconds),
            command: command.to_string(),
        });
    }
    processes.sort_by(|a, b| {
        b.cpu_pct
            .total_cmp(&a.cpu_pct)
            .then_with(|| b.resident_bytes.cmp(&a.resident_bytes))
    });
    processes.truncate(limit);
    processes
}

fn parse_gpus(lines: &[String]) -> (Vec<GpuStatus>, HashMap<String, i64>) {
    let mut gpus = Vec::new();
    let mut uuid_to_index: HashMap<String, i64> = HashMap::new();
    for line in lines {
        let columns: Vec<String> = line.split(',').map(|x| x.trim().to_string()).collect();
        if columns.len() < 9 {
            continue;
        }
        if let Ok(index) = columns[0].parse::<i64>() {
            uuid_to_index.insert(columns[1].clone(), index);
            gpus.push(GpuStatus {
                index,
                name: columns[2].clone(),
                mu: parse_f64_or_zero(&columns[3]) as i64,
                mt: parse_f64_or_zero(&columns[4]) as i64,
                util: parse_f64_or_zero(&columns[5]) as i64,
                temp: parse_f64_or_zero(&columns[6]) as i64,
                pow: parse_f64_or_zero(&columns[7]),
                plim: parse_f64_or_zero(&columns[8]) as i64,
            });
        }
    }
    (gpus, uuid_to_index)
}

fn parse_ps_map(lines: &[String]) -> HashMap<i64, (String, String, String)> {
    let mut pid_info: HashMap<i64, (String, String, String)> = HashMap::new();
    for line in lines {
        // Skip any PS line we can't fully tokenize/parse.
        let Some((pid_str, rest)) = next_token(line) else {
            continue;
        };
        let Some((user, rest)) = next_token(rest) else {
            continue;
        };
        let Some((etime, rest)) = next_token(rest) else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<i64>() else {
            continue;
        };
        let etime = etime
            .parse::<i64>()
            .map(fmt_dur)
            .unwrap_or_else(|_| etime.to_string());
        pid_info.insert(
            pid,
            (user.to_string(), etime, rest.trim_start().to_string()),
        );
    }
    pid_info
}

// (pid, gpu uuid, used VRAM MiB) for each compute process reported by nvidia-smi.
fn parse_apps(lines: &[String]) -> Vec<(i64, String, i64)> {
    let mut apps = Vec::new();
    for line in lines {
        let columns: Vec<String> = line.split(',').map(|x| x.trim().to_string()).collect();
        if columns.len() < 3 {
            continue;
        }
        if let Ok(pid) = columns[0].parse::<i64>() {
            apps.push((
                pid,
                columns[1].clone(),
                parse_f64_or_zero(&columns[2]) as i64,
            ));
        }
    }
    apps
}

pub(crate) fn parse_gather(text: &str, process_scope: ProcessScope) -> HostStatus {
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
    let uptime_seconds = first("UP").trim().parse::<u64>().ok();
    let up = uptime_seconds
        .and_then(|seconds| i64::try_from(seconds).ok())
        .map(fmt_dur)
        .unwrap_or_default();
    let load = {
        let parts: Vec<f64> = first("LOAD")
            .split_whitespace()
            .take(3)
            .filter_map(|x| x.parse().ok())
            .collect();
        if parts.len() == 3 {
            [parts[0], parts[1], parts[2]]
        } else {
            [0.0, 0.0, 0.0]
        }
    };
    let ncpu = first("NCPU").trim().parse::<i64>().unwrap_or(0);
    let mem = {
        let p: Vec<i64> = first("MEM")
            .split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect();
        if p.len() == 2 {
            MemoryStatus {
                total: p[0],
                used: p[1],
            }
        } else {
            MemoryStatus::default()
        }
    };
    let disks = parse_disks(&get("DF"));
    let network = parse_network(&get("NET"), uptime_seconds);
    let top_procs = parse_top_processes(&get("TOP"), process_scope.row_limit());
    let (gpus, uuid_to_index) = parse_gpus(&get("GPU"));
    let apps = parse_apps(&get("APPS"));
    let ps_by_pid = parse_ps_map(&get("PS"));
    let procs = apps
        .iter()
        .map(|(pid, uuid, mem)| {
            let (user, etime, cmd) = ps_by_pid
                .get(pid)
                .cloned()
                .unwrap_or_else(|| ("?".into(), String::new(), String::new()));
            GpuProcessStatus {
                pid: *pid,
                gpu: uuid_to_index.get(uuid).copied().unwrap_or(0),
                mem: *mem,
                user,
                etime,
                cmd,
            }
        })
        .collect();

    HostStatus {
        host,
        up,
        load,
        ncpu,
        mem,
        disks,
        gpus,
        procs,
        network,
        top_procs,
        ..HostStatus::default()
    }
}

pub(crate) fn offline(s: &Server, err: &str) -> HostStatus {
    HostStatus {
        id: s.id.clone(),
        error: Some(err.to_string()),
        ..HostStatus::default()
    }
}

pub(crate) fn online(s: &Server, out: &str, process_scope: ProcessScope) -> HostStatus {
    let mut status = parse_gather(out, process_scope);
    status.id = s.id.clone();
    status.online = true;
    status
}

// ---------------------------------------------------------------- status / fleet
pub async fn status_for(s: Server, process_scope: ProcessScope) -> HostStatus {
    match s.kind.as_str() {
        "wsl" => return crate::wsl::status(&s, process_scope).await,
        "nas" => return crate::nas::status(&s).await,
        "ssh" => {}
        _ => return offline(&s, "unsupported host kind"),
    }
    match async {
        let handle = connect(&s).await?;
        exec_raw(&handle, &gather_command(process_scope)).await
    }
    .await
    {
        Ok(out) => online(&s, &out, process_scope),
        Err(e) => offline(&s, &e),
    }
}

static FLEET_CACHE: Mutex<Option<(Instant, Vec<Option<HostStatus>>)>> = Mutex::new(None);
// single-flight guard: only ONE fleet scan may run at a time. Overlapping polls return
// the cached snapshot instead of each launching a fresh set of SSH connects — that pile-up
// (slowest host gates a ~16s scan, frontend polls every 5s) is what stormed the sshds and
// made healthy servers flap offline/online.
static FLEET_REFRESHING: AtomicBool = AtomicBool::new(false);
const FLEET_TTL: Duration = Duration::from_secs(3);

// One concurrent scan of every configured host (reachable + unreachable).
fn configured_order(
    server_count: usize,
    completed: Vec<(usize, HostStatus)>,
) -> Vec<Option<HostStatus>> {
    let mut ordered = vec![None; server_count];
    for (index, status) in completed {
        if let Some(slot) = ordered.get_mut(index) {
            *slot = Some(status);
        }
    }
    ordered
}

async fn fleet_scan() -> Vec<Option<HostStatus>> {
    let servers = config::get().servers.clone();
    let n = servers.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, s) in servers.into_iter().enumerate() {
        set.spawn(async move { (i, status_for(s, ProcessScope::Mine).await) });
    }
    let mut completed = Vec::with_capacity(n);
    while let Some(res) = set.join_next().await {
        if let Ok(status) = res {
            completed.push(status);
        }
    }
    configured_order(n, completed)
}

pub async fn fleet() -> Vec<Option<HostStatus>> {
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
    if let Some(i) = out.rfind(CWD_MARKER) {
        let text = out[..i].trim_end_matches('\n').to_string();
        let newcwd = out[i + CWD_MARKER.len()..].trim().to_string();
        let resolved_cwd = if newcwd.is_empty() {
            cwd.to_string()
        } else {
            newcwd
        };
        (text, resolved_cwd)
    } else {
        (out.to_string(), cwd.to_string())
    }
}

pub async fn exec_cmd(s: &Server, cwd: &str, cmd: &str) -> Result<(String, String), String> {
    let full = format!(
        "cd {} 2>/dev/null\n{}\nprintf '\\n{}%s' \"$(pwd)\"",
        shell_quote(cwd),
        cmd,
        CWD_MARKER
    );
    let handle = connect(s).await?;
    let out = exec_raw(&handle, &full).await?;
    Ok(split_cwd(&out, cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str) -> Server {
        Server {
            id: id.to_string(),
            name: id.to_string(),
            kind: "ssh".to_string(),
            host: None,
            port: None,
            user: None,
            gpu_label: None,
            home: None,
            group: None,
            custom: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn representative_gather_output_maps_every_metric() {
        let gathered = parse_gather(
            r#"@@HOST
compute-01
@@UP
90061
@@LOAD
1.25 0.75 0.50 2/100 1234
@@NCPU
16
@@MEM
68719476736 17179869184
@@DF
/ 1000000 250000
/data 4000000 1000000
@@NET
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
 wlan0: 3000 1 0 0 0 0 0 0 4000 1 0 0 0 0 0 0
@@TOP
1002 bob 8.5 1.5 4096 65 python worker.py --queue long jobs
1001 alice 8.5 2.0 8192 3661 cargo test --workspace
@@GPU
2, GPU-abc, Example GPU, 1024, 24576, 75, 61, 123.5, 300
@@APPS
4321, GPU-abc, 2048
@@PS
4321 alice 3661 python train.py --epochs 2
@@END
"#,
            ProcessScope::Mine,
        );

        assert_eq!(gathered.host, "compute-01");
        assert_eq!(gathered.up, "1d 1h");
        assert_eq!(gathered.load, [1.25, 0.75, 0.5]);
        assert_eq!(gathered.ncpu, 16);
        assert_eq!(
            gathered.network,
            NetworkStatus {
                available: true,
                rx_bytes: 4_000,
                tx_bytes: 6_000,
                uptime_seconds: 90_061,
            }
        );
        assert_eq!(
            gathered.top_procs,
            vec![
                TopProcessStatus {
                    pid: 1001,
                    user: "alice".to_string(),
                    cpu_pct: 8.5,
                    memory_pct: 2.0,
                    resident_bytes: 8_388_608,
                    elapsed: "1h 1m".to_string(),
                    command: "cargo test --workspace".to_string(),
                },
                TopProcessStatus {
                    pid: 1002,
                    user: "bob".to_string(),
                    cpu_pct: 8.5,
                    memory_pct: 1.5,
                    resident_bytes: 4_194_304,
                    elapsed: "1m".to_string(),
                    command: "python worker.py --queue long jobs".to_string(),
                },
            ]
        );
        assert_eq!(
            gathered.mem,
            MemoryStatus {
                total: 68_719_476_736,
                used: 17_179_869_184,
            }
        );
        assert_eq!(
            gathered.disks,
            vec![
                DiskStatus {
                    m: "/".to_string(),
                    size: 1_000_000,
                    used: 250_000,
                },
                DiskStatus {
                    m: "/data".to_string(),
                    size: 4_000_000,
                    used: 1_000_000,
                },
            ]
        );
        assert_eq!(
            gathered.gpus,
            vec![GpuStatus {
                index: 2,
                name: "Example GPU".to_string(),
                mu: 1024,
                mt: 24_576,
                util: 75,
                temp: 61,
                pow: 123.5,
                plim: 300,
            }]
        );
        assert_eq!(
            gathered.procs,
            vec![GpuProcessStatus {
                pid: 4321,
                gpu: 2,
                mem: 2048,
                user: "alice".to_string(),
                etime: "1h 1m".to_string(),
                cmd: "python train.py --epochs 2".to_string(),
            }]
        );
    }

    #[test]
    fn malformed_or_missing_gather_sections_keep_empty_defaults() {
        let gathered = parse_gather(
            r#"@@UP
not-a-duration
@@LOAD
1.0 invalid 3.0
@@NCPU
many
@@MEM
100 invalid
@@DF
/ invalid 1
missing-fields 10
@@NET
eth0: invalid 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
@@TOP
10 alice NaN 1.0 100 20 bad-cpu
11 bob 2.0 invalid 100 20 bad-memory
12 carol 2.0 1.0 invalid 20 bad-rss
13 dave 2.0 1.0 100 invalid bad-elapsed
14 erin 2.0 1.0 100 20
@@GPU
invalid, GPU-abc, Example GPU, 1, 2, 3, 4, 5, 6
@@APPS
invalid, GPU-abc, 100
@@PS
invalid alice 20 command
@@END
"#,
            ProcessScope::Mine,
        );

        assert_eq!(gathered.host, "");
        assert_eq!(gathered.up, "");
        assert_eq!(gathered.load, [0.0, 0.0, 0.0]);
        assert_eq!(gathered.ncpu, 0);
        assert_eq!(gathered.mem, MemoryStatus::default());
        assert!(gathered.disks.is_empty());
        assert!(gathered.gpus.is_empty());
        assert!(gathered.procs.is_empty());
        assert_eq!(gathered.network, NetworkStatus::default());
        assert!(gathered.top_procs.is_empty());
    }

    #[test]
    fn partial_new_sections_keep_valid_processes_and_reject_incomplete_network_totals() {
        let gathered = parse_gather(
            r#"@@UP
120
@@NET
lo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0
eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
wlan0: malformed
@@TOP
bad row
21 alice 12.5 3.0 2048 120 command with spaces
22 bob inf 4.0 4096 60 malformed cpu
@@END
"#,
            ProcessScope::Mine,
        );

        assert_eq!(gathered.network, NetworkStatus::default());
        assert_eq!(
            gathered.top_procs,
            vec![TopProcessStatus {
                pid: 21,
                user: "alice".to_string(),
                cpu_pct: 12.5,
                memory_pct: 3.0,
                resident_bytes: 2_097_152,
                elapsed: "2m".to_string(),
                command: "command with spaces".to_string(),
            }]
        );
    }

    #[test]
    fn top_processes_are_sorted_and_enforce_scope_limits() {
        let mut lines: Vec<String> = (1..=60)
            .map(|pid| format!("{pid} user {} 1.0 {pid} 60 command {pid}", pid % 4))
            .collect();
        lines.push("malformed row".to_string());

        let mine = parse_top_processes(&lines, ProcessScope::Mine.row_limit());
        let others = parse_top_processes(&lines, ProcessScope::Others.row_limit());
        let root = parse_top_processes(&lines, ProcessScope::Root.row_limit());

        assert_eq!(mine.len(), 20);
        assert_eq!(others.len(), 50);
        assert_eq!(root.len(), 50);
        assert!(others
            .windows(2)
            .all(|pair| pair[0].cpu_pct > pair[1].cpu_pct
                || (pair[0].cpu_pct == pair[1].cpu_pct
                    && pair[0].resident_bytes >= pair[1].resident_bytes)));
    }

    #[test]
    fn process_scopes_generate_fixed_uid_filters_and_row_limits() {
        let mine = gather_command(ProcessScope::Mine);
        let others = gather_command(ProcessScope::Others);
        let root = gather_command(ProcessScope::Root);

        assert!(mine.contains("EFFECTIVE_UID=$(id -u)"));
        assert!(mine.contains("$1 == uid {"));
        assert!(mine.contains("head -n 20"));

        assert!(others.contains("EFFECTIVE_UID=$(id -u)"));
        assert!(others.contains("$1 != uid && $1 != 0 {"));
        assert!(others.contains("head -n 50"));

        assert!(root.contains("awk '$1 == 0 {"));
        assert!(root.contains("head -n 50"));

        for command in [mine, others, root] {
            assert_eq!(command.matches("echo '@@TOP'").count(), 1);
            assert_eq!(command.matches("echo '@@END'").count(), 1);
        }
    }

    #[test]
    fn online_and_offline_serialize_the_complete_contract() {
        let server = server("host-1");

        assert_eq!(
            serde_json::to_value(online(
                &server,
                "@@HOST\nnode-1\n@@END\n",
                ProcessScope::Mine,
            ))
            .expect("online status should serialize"),
            serde_json::json!({
                "id": "host-1", "online": true, "error": null, "host": "node-1", "up": "",
                "load": [0.0, 0.0, 0.0], "ncpu": 0, "mem": {"total": 0, "used": 0},
                "disks": [], "gpus": [], "procs": [],
                "network": {"available": false, "rx_bytes": 0, "tx_bytes": 0, "uptime_seconds": 0},
                "top_procs": []
            })
        );
        assert_eq!(
            serde_json::to_value(offline(&server, "connection failed"))
                .expect("offline status should serialize"),
            serde_json::json!({
                "id": "host-1", "online": false, "error": "connection failed", "host": "", "up": "",
                "load": [0.0, 0.0, 0.0], "ncpu": 0, "mem": {"total": 0, "used": 0},
                "disks": [], "gpus": [], "procs": [],
                "network": {"available": false, "rx_bytes": 0, "tx_bytes": 0, "uptime_seconds": 0},
                "top_procs": []
            })
        );
    }

    #[test]
    fn fleet_results_restore_configured_order() {
        let completed = vec![
            (2, online(&server("third"), "", ProcessScope::Mine)),
            (0, online(&server("first"), "", ProcessScope::Mine)),
            (1, online(&server("second"), "", ProcessScope::Mine)),
        ];

        let ordered = configured_order(3, completed);
        let ids: Vec<&str> = ordered
            .iter()
            .map(|status| {
                status
                    .as_ref()
                    .expect("status should be present")
                    .id
                    .as_str()
            })
            .collect();

        assert_eq!(ids, ["first", "second", "third"]);
    }
}
