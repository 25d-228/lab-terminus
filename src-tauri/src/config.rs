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
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
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

// Sanitized default registry, used to seed the per-user config on first run.
const DEFAULT_CONFIG: &str = include_str!("../../config.default.json");

const DEFAULT_FOLDERS: &[(&str, &str)] = &[
    ("lab", "Lab Servers"),
    ("this", "This Machine"),
    ("storage", "Storage"),
];

// How many parent directories to climb from the exe looking for a dev config.local.json —
// deep enough to reach the repo root from target/<profile>/ on any platform.
const DEV_CONFIG_SEARCH_DEPTH: usize = 6;
// How often the watcher polls the config file's mtime for hand edits.
const WATCH_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

static STATE: OnceLock<RwLock<Arc<Config>>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();
static REV: AtomicU64 = AtomicU64::new(1);
// Serializes read-modify-write cycles (mutations and reloads) so concurrent panel
// actions / watcher reloads can't lose each other's updates.
static MUT_LOCK: Mutex<()> = Mutex::new(());

fn dev_path(current_dir: &Path, executable: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = vec![current_dir.join("config.local.json")];
    if let Some(parent) = current_dir.parent() {
        candidates.push(parent.join("config.local.json"));
    }
    if let Some(executable) = executable {
        let mut dir_cursor = executable.parent().map(Path::to_path_buf);
        for _ in 0..DEV_CONFIG_SEARCH_DEPTH {
            if let Some(dir) = &dir_cursor {
                candidates.push(dir.join("config.local.json"));
                dir_cursor = dir.parent().map(Path::to_path_buf);
            }
        }
    }
    candidates.into_iter().find(|path| path.exists())
}

fn appdata_path(appdata: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    let base = appdata
        .map(PathBuf::from)
        .or_else(|| home.map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("LabTerminus").join("config.json")
}

struct SelectedPath {
    path: PathBuf,
    seed_default: bool,
}

fn select_path(
    explicit: Option<&OsStr>,
    current_dir: &Path,
    executable: Option<&Path>,
    user_path: PathBuf,
) -> SelectedPath {
    if let Some(path) = explicit {
        return SelectedPath {
            path: PathBuf::from(path),
            seed_default: false,
        };
    }
    if let Some(path) = dev_path(current_dir, executable) {
        return SelectedPath {
            path,
            seed_default: false,
        };
    }
    SelectedPath {
        path: user_path,
        seed_default: true,
    }
}

/// Seed only a missing file. `create_new` prevents a concurrent or invalid existing
/// runtime config from being replaced.
fn seed_default(path: &Path) -> std::io::Result<bool> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(DEFAULT_CONFIG.as_bytes())?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

/// The file the app actually reads/writes (resolved once).
pub fn path() -> &'static PathBuf {
    PATH.get_or_init(|| {
        let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let executable = std::env::current_exe().ok();
        let user_path = appdata_path(
            std::env::var_os("APPDATA").as_deref(),
            std::env::var_os("HOME").as_deref(),
        );
        let selected = select_path(
            std::env::var_os("LAB_TERMINUS_CONFIG").as_deref(),
            &current_dir,
            executable.as_deref(),
            user_path,
        );
        if selected.seed_default {
            match seed_default(&selected.path) {
                Ok(true) => eprintln!(
                    "[config] seeded default config at {}",
                    selected.path.display()
                ),
                Ok(false) => {}
                Err(error) => eprintln!(
                    "[config] could not seed {}: {error}",
                    selected.path.display()
                ),
            }
        }
        selected.path
    })
}

/// Capitalize each letter that follows a non-letter, like Python's str.title().
fn titleize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_alpha = false;
    for c in s.chars() {
        if c.is_alphabetic() && !prev_alpha {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        prev_alpha = c.is_alphabetic();
    }
    out
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
    for group in missing {
        let title = titleize(&group);
        cfg.folders.push(Folder {
            key: group,
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

/// Parse config text. Tolerates a UTF-8 BOM (Notepad writes one).
fn parse_config(text: &str) -> Result<Config, serde_json::Error> {
    serde_json::from_str::<Config>(text.trim_start_matches('\u{feff}')).map(normalize)
}

fn read_file(path: &Path) -> Option<Config> {
    match std::fs::read_to_string(path) {
        Ok(text) => match parse_config(&text) {
            Ok(config) => Some(config),
            Err(error) => {
                eprintln!("[config] parse error in {}: {error}", path.display());
                None
            }
        },
        Err(error) => {
            eprintln!("[config] read error {}: {error}", path.display());
            None
        }
    }
}

fn baked() -> Config {
    parse_config(DEFAULT_CONFIG).unwrap_or_default()
}

fn state() -> &'static RwLock<Arc<Config>> {
    STATE.get_or_init(|| RwLock::new(Arc::new(read_file(path()).unwrap_or_else(baked))))
}

/// Snapshot of the current config. Bind it to a local before borrowing fields.
pub fn get() -> Arc<Config> {
    state().read().unwrap().clone()
}

/// Look up a server by id in the current registry snapshot.
pub(crate) fn find(id: &str) -> Option<Server> {
    get().servers.iter().find(|s| s.id == id).cloned()
}

/// Config revision — bumped on every reload or mutation; exposed via /api/fleet.
pub fn rev() -> u64 {
    REV.load(Ordering::Relaxed)
}

pub fn force_reload() {
    // On an unparseable file (mid-edit save, syntax slip) keep the previous config —
    // never silently swap in the baked default.
    let _g = MUT_LOCK.lock().unwrap();
    if let Some(cfg) = read_file(path()) {
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
            std::thread::sleep(WATCH_POLL_INTERVAL);
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
    let replaced: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = replaced.trim_matches('-');
    // Collapse runs of '-' (left by adjacent non-alphanumeric chars) into a single separator.
    let collapsed = trimmed
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "item".into()
    } else {
        collapsed
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

pub fn add_server(fields: &serde_json::Value) -> Result<Server, String> {
    let name = fields["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("server name required".into());
    }
    mutate(|cfg| {
        let taken: Vec<String> = cfg.servers.iter().map(|s| s.id.clone()).collect();
        let trimmed_field = |k: &str| {
            fields[k]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let s = Server {
            id: unique(&slug(&name), &taken),
            name,
            kind: trimmed_field("kind").unwrap_or_else(|| "ssh".into()),
            host: trimmed_field("host"),
            port: parse_port(&fields["port"]),
            user: trimmed_field("user"),
            gpu_label: trimmed_field("gpuLabel"),
            home: trimmed_field("home"),
            group: Some(trimmed_field("group").unwrap_or_else(|| "lab".into())),
            custom: Some(true),
            extra: Default::default(),
        };
        cfg.servers.push(s.clone());
        Ok(s)
    })
}

pub fn edit_server(sid: &str, fields: &serde_json::Value) -> Result<Server, String> {
    mutate(|cfg| {
        let s = cfg
            .servers
            .iter_mut()
            .find(|s| s.id == sid)
            .ok_or("unknown server")?;
        let trimmed_field = |k: &str| fields[k].as_str().map(|v| v.trim().to_string());
        if let Some(n) = trimmed_field("name").filter(|n| !n.is_empty()) {
            s.name = n;
        }
        if let Some(k) = trimmed_field("kind").filter(|k| !k.is_empty()) {
            s.kind = k;
        }
        // Each present key sets its field; an empty string clears it to None.
        for (key, field) in [
            ("host", &mut s.host),
            ("user", &mut s.user),
            ("gpuLabel", &mut s.gpu_label),
            ("home", &mut s.home),
        ] {
            if let Some(v) = trimmed_field(key) {
                *field = if v.is_empty() { None } else { Some(v) };
            }
        }
        if let Some(v) = trimmed_field("group").filter(|v| !v.is_empty()) {
            s.group = Some(v);
        }
        // "port" present → set (invalid/empty clears, like the prototype); absent → keep
        if fields.as_object().is_some_and(|o| o.contains_key("port")) {
            s.port = parse_port(&fields["port"]);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "lab-terminus-config-test-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn contains_sensitive_field(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
                matches!(
                    key.as_str(),
                    "account" | "address" | "host" | "hostLocal" | "passwd" | "password" | "user"
                ) || contains_sensitive_field(value)
            }),
            serde_json::Value::Array(values) => values.iter().any(contains_sensitive_field),
            _ => false,
        }
    }

    #[test]
    fn tracked_default_is_valid_and_sanitized() {
        let config = parse_config(DEFAULT_CONFIG).expect("tracked default should parse");
        let value: serde_json::Value =
            serde_json::from_str(DEFAULT_CONFIG).expect("tracked default should be valid JSON");

        assert!(config.servers.is_empty());
        assert!(config.nas.is_none());
        assert!(config.key.is_none());
        assert!(!contains_sensitive_field(&value));
    }

    #[test]
    fn missing_target_is_seeded_from_tracked_default() {
        let directory = TestDir::new();
        let target = directory.path().join("nested").join("config.json");

        assert!(seed_default(&target).expect("missing target should be seeded"));
        assert_eq!(
            std::fs::read_to_string(&target).expect("seeded target should be readable"),
            DEFAULT_CONFIG
        );
        parse_config(
            &std::fs::read_to_string(target).expect("seeded target should remain readable"),
        )
        .expect("seeded target should parse");
    }

    #[test]
    fn existing_invalid_target_is_not_replaced() {
        let directory = TestDir::new();
        let target = directory.path().join("config.json");
        let existing = "{ existing config being edited";
        std::fs::write(&target, existing).expect("existing target should be written");

        assert!(!seed_default(&target).expect("existing target should be preserved"));
        assert_eq!(
            std::fs::read_to_string(target).expect("existing target should be readable"),
            existing
        );
    }

    #[test]
    fn bom_parsing_applies_folder_normalization() {
        let text = concat!(
            "\u{feff}",
            r#"{"servers":[{"id":"demo","name":"Demo","kind":"ssh","group":"research-team"}],"folders":[]}"#
        );

        let config = parse_config(text).expect("BOM-prefixed config should parse");

        assert_eq!(config.folders.len(), DEFAULT_FOLDERS.len() + 1);
        assert!(config
            .folders
            .iter()
            .any(|folder| folder.key == "research-team" && folder.title == "Research-Team"));
    }

    #[test]
    fn path_selection_preserves_explicit_dev_and_user_precedence() {
        let directory = TestDir::new();
        let current_dir = directory.path().join("workspace");
        std::fs::create_dir(&current_dir).expect("workspace should be created");
        let dev_config = current_dir.join("config.local.json");
        std::fs::write(&dev_config, "{}").expect("development config should be written");
        let explicit = directory.path().join("override.json");
        let user = directory.path().join("user").join("config.json");

        let selected = select_path(Some(explicit.as_os_str()), &current_dir, None, user.clone());
        assert_eq!(selected.path, explicit);
        assert!(!selected.seed_default);

        let selected = select_path(None, &current_dir, None, user.clone());
        assert_eq!(selected.path, dev_config);
        assert!(!selected.seed_default);

        let empty_dir = directory.path().join("empty").join("current");
        std::fs::create_dir_all(&empty_dir).expect("empty directory should be created");
        let selected = select_path(None, &empty_dir, None, user.clone());
        assert_eq!(selected.path, user);
        assert!(selected.seed_default);
    }

    #[test]
    fn executable_ancestor_development_config_is_discovered() {
        let directory = TestDir::new();
        let repository = directory.path().join("repository");
        let config_path = repository.join("config.local.json");
        std::fs::create_dir(&repository).expect("repository directory should be created");
        std::fs::write(&config_path, "{}").expect("development config should be written");
        let executable = repository.join("target").join("debug").join("lab-terminus");
        let unrelated_current_dir = directory.path().join("run").join("current");
        std::fs::create_dir_all(&unrelated_current_dir)
            .expect("unrelated current directory should be created");

        assert_eq!(
            dev_path(&unrelated_current_dir, Some(&executable)),
            Some(config_path)
        );
    }

    #[test]
    fn per_user_path_prefers_appdata_then_home() {
        let appdata = Path::new("appdata-root");
        let home = Path::new("home-root");

        assert_eq!(
            appdata_path(Some(appdata.as_os_str()), Some(home.as_os_str())),
            appdata.join("LabTerminus").join("config.json")
        );
        assert_eq!(
            appdata_path(None, Some(home.as_os_str())),
            home.join(".config").join("LabTerminus").join("config.json")
        );
    }
}
