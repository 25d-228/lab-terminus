//! Config: a real, user-editable file.
//!
//! Resolution order for the active file:
//!   1. LAB_TERMINUS_CONFIG env var (tests / power users)
//!   2. a `config.local.json` found next to the exe or up the tree (dev runs from the repo)
//!   3. `%APPDATA%\LabTerminus\config.json` — the installed app; seeded from the baked-in
//!      default on first run so the app works out of the box.
//!
//! The file is watched (mtime poll) and hot-reloaded; every change (file edit or panel
//! mutation) bumps REV, which /api/fleet exposes so the frontend refreshes its registry.
//! Unknown JSON fields are preserved via #[serde(flatten)] so hand-edits survive a save.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(rename = "gpuLabel", default, skip_serializing_if = "Option::is_none")]
    pub gpu_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Folder {
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Nas {
    pub scheme: String,
    pub host: String,
    /// Optional LAN address tried when `host` is unreachable (e.g. on the lab network,
    /// where the router's public IP can't be reached from inside — NAT hairpin).
    #[serde(rename = "hostLocal", default, skip_serializing_if = "Option::is_none")]
    pub host_local: Option<String>,
    pub port: u16,
    pub account: String,
    pub passwd: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct Wsl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nas: Option<Nas>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<Wsl>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

// Baked-in default registry (the lab fleet), used to seed the APPDATA config on first run.
// NOTE: embeds config.local.json (incl. NAS creds) — fine for a personal build; don't redistribute.
const DEFAULT_CONFIG: &str = include_str!("../../config.local.json");

const DEFAULT_FOLDERS: &[(&str, &str)] = &[
    ("lab", "Lab Servers"),
    ("this", "This Machine"),
    ("storage", "Storage"),
];

static STATE: OnceLock<RwLock<Arc<Config>>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();
static REV: AtomicU64 = AtomicU64::new(1);
// Serializes read-modify-write cycles (mutations and reloads) so concurrent panel
// actions / watcher reloads can't lose each other's updates.
static MUT_LOCK: Mutex<()> = Mutex::new(());

fn dev_path() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec!["config.local.json".into(), "../config.local.json".into()];
    if let Ok(exe) = std::env::current_exe() {
        let mut d = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(dir) = &d {
                cands.push(dir.join("config.local.json"));
                d = dir.parent().map(|p| p.to_path_buf());
            }
        }
    }
    cands.into_iter().find(|p| p.exists())
}

fn appdata_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("LabTerminus").join("config.json")
}

/// The file the app actually reads/writes (resolved once).
pub fn path() -> &'static PathBuf {
    PATH.get_or_init(|| {
        if let Ok(p) = std::env::var("LAB_TERMINUS_CONFIG") {
            return PathBuf::from(p);
        }
        if let Some(p) = dev_path() {
            return p;
        }
        let p = appdata_path();
        if !p.exists() {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Err(e) = std::fs::write(&p, DEFAULT_CONFIG) {
                eprintln!("[config] could not seed {}: {e}", p.display());
            } else {
                eprintln!("[config] seeded default config at {}", p.display());
            }
        }
        p
    })
}

fn normalize(mut cfg: Config) -> Config {
    if cfg.folders.is_empty() {
        cfg.folders = DEFAULT_FOLDERS
            .iter()
            .map(|(k, t)| Folder {
                key: (*k).into(),
                title: (*t).into(),
                custom: None,
                extra: Default::default(),
            })
            .collect();
    }
    // every server's non-empty group gets a folder (mirrors the prototype's truthiness check)
    let keys: Vec<String> = cfg.folders.iter().map(|f| f.key.clone()).collect();
    let mut missing: Vec<String> = Vec::new();
    for s in &cfg.servers {
        if let Some(g) = &s.group {
            if !g.is_empty() && !keys.contains(g) && !missing.contains(g) {
                missing.push(g.clone());
            }
        }
    }
    for g in missing {
        // Python str.title(): capitalize each letter that follows a non-letter
        let mut title = String::with_capacity(g.len());
        let mut prev_alpha = false;
        for c in g.chars() {
            if c.is_alphabetic() && !prev_alpha {
                title.extend(c.to_uppercase());
            } else {
                title.push(c);
            }
            prev_alpha = c.is_alphabetic();
        }
        cfg.folders.push(Folder {
            key: g,
            title,
            custom: None,
            extra: Default::default(),
        });
    }
    cfg
}

/// 1–65535 from a JSON number or numeric string; anything else is None (no silent wrap).
fn parse_port(v: &serde_json::Value) -> Option<u16> {
    let n = v
        .as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))?;
    u16::try_from(n).ok().filter(|p| *p > 0)
}

/// Parse the active file. Tolerates a UTF-8 BOM (Notepad writes one).
fn read_file() -> Option<Config> {
    let p = path();
    match std::fs::read_to_string(p) {
        Ok(text) => match serde_json::from_str::<Config>(text.trim_start_matches('\u{feff}')) {
            Ok(cfg) => Some(normalize(cfg)),
            Err(e) => {
                eprintln!("[config] parse error in {}: {e}", p.display());
                None
            }
        },
        Err(e) => {
            eprintln!("[config] read error {}: {e}", p.display());
            None
        }
    }
}

fn baked() -> Config {
    match serde_json::from_str::<Config>(DEFAULT_CONFIG) {
        Ok(cfg) => normalize(cfg),
        Err(_) => Config::default(),
    }
}

fn state() -> &'static RwLock<Arc<Config>> {
    STATE.get_or_init(|| RwLock::new(Arc::new(read_file().unwrap_or_else(baked))))
}

/// Snapshot of the current config. Bind it to a local before borrowing fields.
pub fn get() -> Arc<Config> {
    state().read().unwrap().clone()
}

/// Config revision — bumped on every reload or mutation; exposed via /api/fleet.
pub fn rev() -> u64 {
    REV.load(Ordering::Relaxed)
}

pub fn force_reload() {
    // On an unparseable file (mid-edit save, syntax slip) keep the previous config —
    // never silently swap in the baked default.
    let _g = MUT_LOCK.lock().unwrap();
    if let Some(cfg) = read_file() {
        *state().write().unwrap() = Arc::new(cfg);
        REV.fetch_add(1, Ordering::Relaxed);
    } else {
        eprintln!("[config] keeping previous config");
    }
}

fn save(cfg: Config) -> Result<(), String> {
    let cfg = normalize(cfg);
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(path(), text).map_err(|e| e.to_string())?;
    *state().write().unwrap() = Arc::new(cfg);
    REV.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// All registry mutations go through here: one lock around the whole
/// clone → mutate → save cycle, so concurrent mutations can't lose updates.
fn mutate<T>(f: impl FnOnce(&mut Config) -> Result<T, String>) -> Result<T, String> {
    let _g = MUT_LOCK.lock().unwrap();
    let mut cfg = (*get()).clone();
    let out = f(&mut cfg)?;
    save(cfg)?;
    Ok(out)
}

/// Watch the config file for hand edits (mtime poll) and hot-reload.
pub fn start_watcher() {
    let p = path().clone();
    std::thread::spawn(move || {
        let mtime = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let mut last = mtime(&p);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let now = mtime(&p);
            if now != last {
                last = now;
                eprintln!("[config] change detected — reloading");
                force_reload();
            }
        }
    });
}

// ---------------------------------------------------------------- registry mutations (ported from the prototype)
fn slug(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    let s = s.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() {
        "item".into()
    } else {
        s
    }
}

fn unique(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    let mut i = 2;
    loop {
        let cand = format!("{base}-{i}");
        if !taken.iter().any(|t| t == &cand) {
            return cand;
        }
        i += 1;
    }
}

pub fn add_folder(title: &str) -> Result<Folder, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("folder name required".into());
    }
    mutate(move |cfg| {
        let taken: Vec<String> = cfg.folders.iter().map(|f| f.key.clone()).collect();
        let folder = Folder {
            key: unique(&slug(&title), &taken),
            title,
            custom: Some(true),
            extra: Default::default(),
        };
        cfg.folders.push(folder.clone());
        Ok(folder)
    })
}

pub fn rename_folder(key: &str, title: &str) -> Result<Folder, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("folder name required".into());
    }
    mutate(move |cfg| {
        let f = cfg
            .folders
            .iter_mut()
            .find(|f| f.key == key)
            .ok_or("unknown folder")?;
        f.title = title;
        Ok(f.clone())
    })
}

pub fn remove_folder(key: &str) -> Result<(), String> {
    mutate(|cfg| {
        if !cfg.folders.iter().any(|f| f.key == key) {
            return Err("unknown folder".into());
        }
        cfg.folders.retain(|f| f.key != key);
        // retain() may have removed several entries (hand-edited duplicate keys) —
        // never leave zero folders, and never index an empty Vec.
        let Some(first) = cfg.folders.first() else {
            return Err("keep at least one folder".into());
        };
        let fallback = first.key.clone();
        for s in &mut cfg.servers {
            if s.group.as_deref() == Some(key) {
                s.group = Some(fallback.clone());
            }
        }
        Ok(())
    })
}

pub fn add_server(d: &serde_json::Value) -> Result<Server, String> {
    let name = d["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("server name required".into());
    }
    mutate(|cfg| {
        let taken: Vec<String> = cfg.servers.iter().map(|s| s.id.clone()).collect();
        let gets =
            |k: &str| d[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let s = Server {
            id: unique(&slug(&name), &taken),
            name,
            kind: gets("kind").unwrap_or_else(|| "ssh".into()),
            host: gets("host"),
            port: parse_port(&d["port"]),
            user: gets("user"),
            gpu_label: gets("gpuLabel"),
            home: gets("home"),
            group: Some(gets("group").unwrap_or_else(|| "lab".into())),
            custom: Some(true),
            extra: Default::default(),
        };
        cfg.servers.push(s.clone());
        Ok(s)
    })
}

pub fn edit_server(sid: &str, d: &serde_json::Value) -> Result<Server, String> {
    mutate(|cfg| {
        let s = cfg
            .servers
            .iter_mut()
            .find(|s| s.id == sid)
            .ok_or("unknown server")?;
        let gets = |k: &str| d[k].as_str().map(|v| v.trim().to_string());
        if let Some(n) = gets("name").filter(|n| !n.is_empty()) {
            s.name = n;
        }
        if let Some(k) = gets("kind").filter(|k| !k.is_empty()) {
            s.kind = k;
        }
        for (key, field) in [("host", &mut s.host), ("user", &mut s.user)] {
            if let Some(v) = gets(key) {
                *field = if v.is_empty() { None } else { Some(v) };
            }
        }
        if let Some(v) = gets("gpuLabel") {
            s.gpu_label = if v.is_empty() { None } else { Some(v) };
        }
        if let Some(v) = gets("home") {
            s.home = if v.is_empty() { None } else { Some(v) };
        }
        if let Some(v) = gets("group").filter(|v| !v.is_empty()) {
            s.group = Some(v);
        }
        // "port" present → set (invalid/empty clears, like the prototype); absent → keep
        if d.as_object().is_some_and(|o| o.contains_key("port")) {
            s.port = parse_port(&d["port"]);
        }
        Ok(s.clone())
    })
}

pub fn remove_server(sid: &str) -> Result<(), String> {
    mutate(|cfg| {
        let before = cfg.servers.len();
        cfg.servers.retain(|s| s.id != sid);
        if cfg.servers.len() == before {
            return Err("unknown server".into());
        }
        Ok(())
    })
}
