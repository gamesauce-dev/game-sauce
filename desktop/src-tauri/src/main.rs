// game-sauce desktop: its own window around game-sauce. Two ways to use it:
//   * on this computer: the server that is built into the app is started (the same program as the portable download), and the window shows it;
//   * on another computer: the window just opens a game-sauce server you already run (Docker, Unraid, a PC at home...).
// The choice is remembered. The library and accounts of the built-in server live in "game-sauce-data" in the home folder, exactly where the
// portable download keeps them, so moving between the two loses nothing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    AppHandle, Manager, RunEvent, Wry,
};
#[cfg(target_os = "macos")]
use tauri::menu::SubmenuBuilder;
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[derive(Default, Serialize, Deserialize, Clone)]
struct Config {
    mode: Option<String>, // "local" | "remote"
    remote_url: Option<String>,
    #[serde(default)]
    lan: bool, // local only: let other devices on the network connect
}

struct AppState {
    server: Mutex<Option<Child>>,
    home_url: Mutex<String>, // the app's own start page, to come back to when switching server
    status: Mutex<Option<MenuItem<Wry>>>, // the line in the tray menu that says where game-sauce is running (Windows and Linux)
}

#[derive(Serialize)]
struct Started {
    url: String,
    username: Option<String>, // only on the very first start: the account that was made
    password: Option<String>,
}

fn clean(p: PathBuf) -> PathBuf {
    // Windows hands back \\?\C:\... paths; Node and cmd do not like those as a working folder.
    let s = p.to_string_lossy().to_string();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s))
}

fn config_path(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("GAMESAUCE_DESKTOP_CONFIG") {
        return clean(PathBuf::from(d)).join("desktop.json"); // for testing: keep the saved choice somewhere else
    }
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("desktop.json")
}

fn read_config(app: &AppHandle) -> Config {
    fs::read_to_string(config_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_config(app: &AppHandle, c: &Config) {
    let p = config_path(app);
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(p, serde_json::to_string_pretty(c).unwrap_or_default());
}

fn data_home(app: &AppHandle) -> PathBuf {
    if let Ok(h) = std::env::var("GAMESAUCE_HOME") {
        return clean(PathBuf::from(h)); // same switch as the start files: keep the library somewhere else
    }
    app.path().home_dir().map(|h| h.join("game-sauce-data")).unwrap_or_else(|_| PathBuf::from("game-sauce-data"))
}

/// The folder holding runtime/ (Node.js) and app/ (the server): inside the installed app, or the staged copy when developing.
fn server_dir(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("GAMESAUCE_SERVER_DIR") {
        return clean(PathBuf::from(d));
    }
    if let Ok(res) = app.path().resource_dir() {
        let res = clean(res);
        if res.join("runtime").exists() {
            return res;
        }
    }
    clean(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server-stage/server"))
}

fn stop_server(state: &AppState) {
    if let Some(mut child) = state.server.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn start_server(app: &AppHandle, lan: bool) -> Result<Started, String> {
    let state = app.state::<AppState>();
    stop_server(&state);
    let dir = server_dir(app);
    let exe = dir.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
    if !exe.exists() {
        return Err(format!("The built-in server is missing ({}). Reinstall game-sauce.", exe.display()));
    }
    let home = data_home(app);
    let (data, storage) = (home.join("data"), home.join("storage"));
    fs::create_dir_all(&data).map_err(|e| format!("Cannot create {}: {e}", data.display()))?;
    fs::create_dir_all(&storage).map_err(|e| format!("Cannot create {}: {e}", storage.display()))?;
    let port = (8765u16..8815).find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok()).ok_or("No free port was found (8765 to 8814 are all busy).")?;

    let mut cmd = Command::new(&exe);
    cmd.current_dir(dir.join("app"))
        .arg("src/server.js")
        .env("HOST", if lan { "0.0.0.0" } else { "127.0.0.1" })
        .env("PORT", port.to_string())
        .env("GAMESAUCE_INSTALL", "desktop")
        .env("GAMESAUCE_DATA_DIR", &data)
        .env("GAMESAUCE_STORAGE_DIR", &storage)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the built-in server: {e}"))?;
    let stdout = child.stdout.take();
    *state.server.lock().unwrap() = Some(child);

    // The server prints the first account's password once, on the very first start: catch it so the window can show it.
    let creds: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::new(Mutex::new((None, None)));
    if let Some(out) = stdout {
        let c = creds.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let t = line.trim();
                if let Some(u) = t.strip_prefix("username:") {
                    c.lock().unwrap().0 = Some(u.trim().to_string());
                } else if let Some(p) = t.strip_prefix("password:") {
                    c.lock().unwrap().1 = Some(p.trim().to_string());
                }
            } // keeps reading until the server ends, so it never blocks on a full pipe
        });
    }

    let url = format!("http://127.0.0.1:{port}");
    let started = Instant::now();
    loop {
        if ureq::get(&format!("{url}/api/health")).timeout(Duration::from_secs(2)).call().map(|r| r.status() == 200).unwrap_or(false) {
            break;
        }
        if let Some(child) = state.server.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("The built-in server stopped while starting (exit code {}).", status.code().unwrap_or(-1)));
            }
        }
        if started.elapsed() > Duration::from_secs(90) {
            return Err("The built-in server did not start in time.".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let (username, password) = creds.lock().unwrap().clone();
    match (lan, lan_ip()) {
        (true, Some(ip)) => set_status(app, &format!("On your network: http://{ip}:{port}")),
        _ => set_status(app, &format!("On this computer only: {url}")),
    }
    Ok(Started { url, username, password })
}

/// The address other devices on the home network would use: the computer's own address on the network it reaches the internet through.
fn lan_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?; // nothing is sent: this only picks the network interface
    Some(s.local_addr().ok()?.ip().to_string())
}

fn set_status(app: &AppHandle, text: &str) {
    if let Some(item) = app.state::<AppState>().status.lock().unwrap().as_ref() {
        let _ = item.set_text(text);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The menu entries (the menu bar on a Mac, the tray icon's menu on Windows and Linux).
fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "switch" => {
            let st = app.state::<AppState>();
            stop_server(&st);
            write_config(app, &Config::default());
            set_status(app, "Choose a server");
            show_main(app);
            if let Some(w) = app.get_webview_window("main") {
                let home = st.home_url.lock().unwrap().clone();
                let _ = w.eval(&format!("location.replace({})", serde_json::to_string(&home).unwrap_or_default()));
            }
        }
        "data" => open_folder(data_home(app)),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn normalise(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    if u.is_empty() {
        return Err("Type the address of your game-sauce server, for example http://192.168.1.20:8765".into());
    }
    let u = if u.starts_with("http://") || u.starts_with("https://") { u.to_string() } else { format!("http://{u}") };
    Ok(u)
}

fn probe(url: &str) -> Result<(), String> {
    match ureq::get(&format!("{url}/api/health")).timeout(Duration::from_secs(6)).call() {
        Ok(r) if r.status() == 200 => Ok(()),
        Ok(r) => Err(format!("{url} answered, but not like game-sauce (status {}).", r.status())),
        Err(e) => Err(format!("Could not reach {url} ({e}). Check the address, and that game-sauce is running there.")),
    }
}

#[tauri::command]
fn get_config(app: AppHandle) -> Config {
    read_config(&app)
}

#[tauri::command]
async fn use_local(app: AppHandle, lan: bool) -> Result<Started, String> {
    let a = app.clone();
    let started = tauri::async_runtime::spawn_blocking(move || start_server(&a, lan)).await.map_err(|e| e.to_string())??;
    write_config(&app, &Config { mode: Some("local".into()), remote_url: None, lan });
    Ok(started)
}

#[tauri::command]
async fn use_remote(app: AppHandle, url: String) -> Result<String, String> {
    let url = normalise(&url)?;
    let u = url.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&u)).await.map_err(|e| e.to_string())??;
    stop_server(&app.state::<AppState>());
    set_status(&app, &format!("Connected to {url}"));
    write_config(&app, &Config { mode: Some("remote".into()), remote_url: Some(url.clone()), lan: false });
    Ok(url)
}

fn open_folder(path: PathBuf) {
    let _ = fs::create_dir_all(&path);
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(opener).arg(path).spawn();
}

fn main() {
    tauri::Builder::default()
        .manage(AppState { server: Mutex::new(None), home_url: Mutex::new(String::new()), status: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![get_config, use_local, use_remote])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(u) = w.url() {
                    *app.state::<AppState>().home_url.lock().unwrap() = u.to_string();
                }
            }
            let switch = MenuItemBuilder::with_id("switch", "Switch server…").build(app)?;
            let data = MenuItemBuilder::with_id("data", "Open my data folder").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").accelerator("CmdOrCtrl+Q").build(app)?;

            // Mac: the menu at the top of the screen, as Mac apps have.
            #[cfg(target_os = "macos")]
            {
                let game = SubmenuBuilder::new(app, "game-sauce").item(&switch).item(&data).separator().item(&quit).build()?;
                let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
                app.set_menu(MenuBuilder::new(app).item(&game).item(&edit).build()?)?;
                app.on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()));
            }

            // Windows and Linux: no menu bar in the window; a small icon in the tray (notification area) instead.
            #[cfg(not(target_os = "macos"))]
            {
                let status = MenuItemBuilder::with_id("status", "Not started yet").enabled(false).build(app)?;
                let open = MenuItemBuilder::with_id("open", "Open game-sauce").build(app)?;
                let menu = MenuBuilder::new(app).item(&open).separator().item(&status).separator().item(&switch).item(&data).separator().item(&quit).build()?;
                *app.state::<AppState>().status.lock().unwrap() = Some(status);
                let mut tray = TrayIconBuilder::with_id("tray")
                    .tooltip("game-sauce")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()))
                    .on_tray_icon_event(|tray, ev| {
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                            show_main(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building game-sauce")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(&app.state::<AppState>());
            }
        });
}
