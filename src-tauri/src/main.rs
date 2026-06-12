// Lab Terminus — Tauri 2 desktop shell.
// A small embedded axum server (server.rs) runs on a loopback port and serves the same
// API + frontend the prototype validated. The window is frameless; closing it hides to
// the system tray (right-click the tray icon for Show / Open config location / Quit).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod nas;
mod pty;
mod server;
mod ssh;
mod transfers;
mod wsl;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// Open the OS file manager with the config file selected.
fn reveal_config() {
    let p = config::path();
    #[cfg(target_os = "windows")]
    {
        // raw_arg: Command::arg would quote the WHOLE "/select,path" token when the path
        // has spaces, which makes Explorer ignore /select and open Documents instead.
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", p.display()))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(["-R", &p.display().to_string()])
            .spawn();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(dir) = p.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pick a save path in Downloads for /api/{id}/download links: the remote file's
/// name, deduplicated with " (n)" if it already exists.
fn download_destination(app: &tauri::AppHandle, url: &str) -> std::path::PathBuf {
    let name = url
        .split("path=")
        .nth(1)
        .map(|q| q.split('&').next().unwrap_or(q))
        .map(percent_decode)
        .map(|p| {
            p.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("download")
                .to_string()
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".into());
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut dest = dir.join(&name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut i = 1;
    while dest.exists() {
        dest = dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    dest
}

fn main() {
    // Headless mode (LT_HEADLESS=1): API server only, fixed port, no GUI — used for testing.
    if std::env::var("LT_HEADLESS").is_ok() {
        return run_headless();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // second launch (e.g. double-clicking the shortcut while we're in the tray)
            // surfaces the existing window instead of starting a duplicate app
            show_main(app);
        }))
        .setup(|app| {
            config::start_watcher();

            // bind a loopback port up front so we can point the window at it
            let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("failed to bind loopback port");
            std_listener.set_nonblocking(true).ok();
            let port = std_listener.local_addr().expect("local_addr").port();

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener)
                    .expect("tokio listener");
                if let Err(e) = axum::serve(listener, server::router()).await {
                    eprintln!("[server] {e}");
                }
            });

            let url = format!("http://127.0.0.1:{port}/");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("url")),
            )
            .title("Lab Terminus")
            .inner_size(1200.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .decorations(false)
            .resizable(true)
            // let HTML5 drag-and-drop (drop files onto Explorer to upload) reach the page —
            // Tauri's own drag-drop handler would swallow it on Windows
            .disable_drag_drop_handler()
            // route download links (Explorer "Download") into the user's Downloads folder
            .on_download(|webview, event| {
                if let tauri::webview::DownloadEvent::Requested { url, destination } = event {
                    *destination = download_destination(webview.app_handle(), url.as_str());
                    eprintln!("[download] {} -> {}", url, destination.display());
                } else if let tauri::webview::DownloadEvent::Finished { success, path, .. } = event
                {
                    eprintln!("[download] finished ok={success} path={path:?}");
                }
                true
            })
            .build()?;

            // system tray: close-to-tray lives here
            let show = MenuItem::with_id(app, "show", "Show Lab Terminus", true, None::<&str>)?;
            let opencfg =
                MenuItem::with_id(app, "opencfg", "Open config file location", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload config", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Lab Terminus", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &sep, &opencfg, &reload, &sep, &quit])?;

            TrayIconBuilder::with_id("lt-tray")
                .icon(app.default_window_icon().expect("icon").clone())
                .tooltip("Lab Terminus")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "opencfg" => reveal_config(),
                    "reload" => {
                        config::force_reload();
                        eprintln!("[config] reloaded from tray");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the window hides to tray; Quit lives in the tray menu
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Lab Terminus")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon while the window is hidden re-opens it
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}

#[tokio::main(flavor = "current_thread")]
async fn run_headless() {
    config::start_watcher();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8766")
        .await
        .expect("bind 127.0.0.1:8766");
    println!("[headless] Lab Terminus API on http://127.0.0.1:8766");
    if let Err(e) = axum::serve(listener, server::router()).await {
        eprintln!("[headless] {e}");
    }
}
