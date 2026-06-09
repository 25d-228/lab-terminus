//! Loads the same `config.local.json` the prototype uses (registry + NAS creds + folders).
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(rename = "gpuLabel", default)]
    pub gpu_label: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub custom: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Folder {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub custom: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Nas {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub account: String,
    pub passwd: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct Wsl {
    #[serde(default)]
    pub distro: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct Config {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub nas: Option<Nas>,
    #[serde(default)]
    pub wsl: Option<Wsl>,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

// Baked-in default registry (the lab fleet), used when no external config.local.json is found —
// e.g. the installed app. Matches the prototype's out-of-the-box behavior.
// NOTE: this embeds config.local.json (incl. NAS creds) into the binary — fine for a personal
// build; don't redistribute this installer.
const DEFAULT_CONFIG: &str = include_str!("../../config.local.json");

fn find_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("LAB_TERMINUS_CONFIG") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let mut cands: Vec<std::path::PathBuf> =
        vec!["config.local.json".into(), "../config.local.json".into()];
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

pub fn load() -> Config {
    if let Some(path) = find_path() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<Config>(&text) {
                Ok(cfg) => return cfg,
                Err(e) => eprintln!("[config] parse error: {e}"),
            }
        }
    } else {
        eprintln!("[config] no external config.local.json — using baked-in default");
    }
    // Fall back to the default baked in at build time (installed app / no external file).
    match serde_json::from_str::<Config>(DEFAULT_CONFIG) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("[config] embedded default parse error: {e}");
            Config::default()
        }
    }
}

pub fn get() -> &'static Config {
    CONFIG.get_or_init(load)
}
