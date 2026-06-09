// Lab Terminus — Tauri 2 desktop shell.
// A small embedded axum server (see server.rs) runs on a loopback port and serves the
// same API the web frontend expects; Tauri opens the frameless window at that local URL.
// The SSH/SFTP/PTY (russh / portable-pty) and Synology (reqwest) handlers are being
// ported from the Python prototype incrementally.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod nas;
mod pty;
mod server;
mod ssh;
mod wsl;

fn main() {
    // Headless mode (LT_HEADLESS=1): run only the API server on a fixed port for testing,
    // with no GUI window. Used to validate the backend against the live fleet via curl.
    if std::env::var("LT_HEADLESS").is_ok() {
        return run_headless();
    }
    tauri::Builder::default()
        .setup(|app| {
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
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lab Terminus");
}

#[tokio::main(flavor = "current_thread")]
async fn run_headless() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8766")
        .await
        .expect("bind 127.0.0.1:8766");
    println!("[headless] Lab Terminus API on http://127.0.0.1:8766");
    if let Err(e) = axum::serve(listener, server::router()).await {
        eprintln!("[headless] {e}");
    }
}
