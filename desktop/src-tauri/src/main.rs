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
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::menu::SubmenuBuilder;
#[cfg(target_os = "linux")]
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[derive(Default, Serialize, Deserialize, Clone)]
struct Config {
    mode: Option<String>, // "local" | "remote"
    remote_url: Option<String>,
    #[serde(default)]
    lan: bool, // local only: let other devices on the network connect
    #[serde(default)]
    graphics: Option<String>, // Linux: "standard" | "hardware" | "software" (how the window is drawn; applies on the next start)
}

struct AppState {
    server: Mutex<Option<Child>>,
    status: Mutex<Option<MenuItem<Wry>>>, // the line in the tray menu that says where game-sauce is running (Windows and Linux)
    #[cfg(target_os = "linux")]
    gfx: Mutex<Vec<(String, CheckMenuItem<Wry>)>>, // Linux: the Graphics choices in the tray menu
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
    let mut c = c.clone();
    if c.graphics.is_none() {
        c.graphics = read_config(app).graphics; // switching server must not forget the graphics choice
    }
    let c = &c;
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

/// The app's own start page (the choice screen), where "Switch server" goes back to. Windows serves the app's pages from http://tauri.localhost, the other systems from tauri://localhost.
/// (It used to be read from the window while starting, before the page had loaded, which gave a blank window.)
#[cfg(windows)]
const APP_HOME: &str = "http://tauri.localhost/";
#[cfg(not(windows))]
const APP_HOME: &str = "tauri://localhost/";

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

/// The launcher (the small helper that starts a game in an emulator on this PC) travels inside the app, next to its own Node.
fn launcher_script(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let dir = server_dir(app);
    let exe = dir.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = dir.join("app").join("launcher").join("gamesauce-launcher.mjs");
    if exe.exists() && script.exists() { Some((exe, script)) } else { None }
}

/// Programs started from the Linux AppImage inherit the AppImage's own library settings, which can stop the computer's browser (xdg-open) or Node from starting.
fn clean_env(cmd: &mut Command) {
    #[cfg(target_os = "linux")]
    for k in ["LD_LIBRARY_PATH", "LD_PRELOAD", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE", "GIO_EXTRA_MODULES", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "PYTHONHOME", "PERLLIB", "QT_PLUGIN_PATH"] {
        cmd.env_remove(k);
    }
    let _ = cmd;
}

/// "Set up emulators…": the launcher opens its setup page (a page on this PC only) in the browser.
fn open_launcher_setup(app: &AppHandle) {
    let Some((exe, script)) = launcher_script(app) else { return };
    let mut cmd = Command::new(exe);
    cmd.arg(script).arg("--configure").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    clean_env(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let _ = cmd.spawn();
}

/// Make "Play on this PC" work without any set-up: point the gamesauce:// link at the launcher inside the app, unless the person already
/// has a working launcher registered (their own copy keeps being used). Windows and Linux; on a Mac use launcher/install-macos.sh.
fn register_launcher_link(app: &AppHandle) {
    let Some((node, script)) = launcher_script(app) else { return };
    let _ = &node; // only the Linux entry needs the program's path
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let vbs = script.with_file_name("gamesauce-launcher.vbs");
        if !vbs.exists() { return; }
        let key = r"HKCU\Software\Classes\gamesauce";
        let cmd_key = format!(r"{key}\shell\open\command");
        let mut q = Command::new("reg");
        q.args(["query", &cmd_key, "/ve"]).creation_flags(0x0800_0000);
        if let Ok(out) = q.output() {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            // Registered to a launcher file that is still there (ours or the person's own): leave it.
            if text.split('"').any(|s| s.to_lowercase().ends_with(".vbs") && std::path::Path::new(s).exists()) { return; }
        }
        let run = |args: &[&str]| { let _ = Command::new("reg").args(args).creation_flags(0x0800_0000).output(); };
        run(&["add", key, "/ve", "/d", "URL:game-sauce launcher", "/f"]);
        run(&["add", key, "/v", "URL Protocol", "/d", "", "/f"]);
        run(&["add", &cmd_key, "/ve", "/d", &format!("wscript.exe \"{}\" \"%1\"", vbs.display()), "/f"]);
    }
    #[cfg(target_os = "linux")]
    {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
        let apps = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("applications");
        let file = apps.join("gamesauce-launcher.desktop");
        if let Ok(old) = fs::read_to_string(&file) {
            // Someone else's (the person's own copy of the launcher) and still there: leave it.
            let ours = old.contains(&script.display().to_string());
            let theirs_ok = old.lines().find(|l| l.starts_with("Exec=")).map(|l| l.split('"').skip(1).step_by(2).any(|s| s.ends_with("gamesauce-launcher.mjs") && std::path::Path::new(s).exists())).unwrap_or(false);
            if !ours && theirs_ok { return; }
        }
        let _ = fs::create_dir_all(&apps);
        let body = format!(
            "[Desktop Entry]\nType=Application\nName=game-sauce launcher\nComment=Opens ROMs from game-sauce in your local emulator\nExec=\"{}\" \"{}\" %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/gamesauce;\n",
            node.display(),
            script.display()
        );
        if fs::write(&file, body).is_ok() {
            let _ = Command::new("update-desktop-database").arg(&apps).output();
            let _ = Command::new("xdg-mime").args(["default", "gamesauce-launcher.desktop", "x-scheme-handler/gamesauce"]).output();
        }
    }
    #[cfg(target_os = "macos")]
    { let _ = (node, script); }
}

/// The menu entries (the menu bar on a Mac, the tray icon's menu on Windows and Linux).
fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "setup" => open_launcher_setup(app),
        "open" => show_main(app),
        "switch" => {
            let st = app.state::<AppState>();
            stop_server(&st);
            write_config(app, &Config::default());
            set_status(app, "Choose a server");
            show_main(app);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("location.replace({})", serde_json::to_string(APP_HOME).unwrap_or_default()));
            }
        }
        "data" => open_folder(data_home(app)),
        #[cfg(target_os = "linux")]
        id if id.starts_with("gfx-") => {
            let mode = id.trim_start_matches("gfx-").to_string();
            let mut c = read_config(app);
            c.graphics = Some(mode.clone());
            write_config(app, &c);
            for (k, item) in app.state::<AppState>().gfx.lock().unwrap().iter() {
                let _ = item.set_checked(*k == mode);
            }
            set_status(app, "Graphics change applies when you quit and reopen game-sauce");
        }
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
    write_config(&app, &Config { mode: Some("local".into()), remote_url: None, lan, graphics: None });
    Ok(started)
}

#[tauri::command]
async fn use_remote(app: AppHandle, url: String) -> Result<String, String> {
    let url = normalise(&url)?;
    let u = url.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&u)).await.map_err(|e| e.to_string())??;
    stop_server(&app.state::<AppState>());
    set_status(&app, &format!("Connected to {url}"));
    write_config(&app, &Config { mode: Some("remote".into()), remote_url: Some(url.clone()), lan: false, graphics: None });
    Ok(url)
}

/// A link that wants a new window (target="_blank", window.open: the Steam and store pages, screenshots, the release page) opens in the person's own browser.
/// Only web addresses are passed on. Without this the window would silently ignore the click.
fn open_external(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let mut cmd = Command::new(opener);
    cmd.arg(url.as_str());
    clean_env(&mut cmd);
    let _ = cmd.spawn();
}

/// gamesauce:// (Play on this PC, Check my PC, Set up emulators) and steam:// links are not pages. The web view on Linux would try to load them
/// and show "URL can't be shown", so they are caught here and handed to the launcher inside the app (or to the system for steam://).
/// Returns true when the link was taken.
fn handle_app_link(app: &AppHandle, url: &tauri::Url) -> bool {
    match url.scheme() {
        "gamesauce" => {
            if let Some((exe, script)) = launcher_script(app) {
                let mut cmd = Command::new(exe);
                cmd.arg(script).arg(url.as_str()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                clean_env(&mut cmd);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0800_0000);
                }
                let _ = cmd.spawn();
            } else {
                let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
                let _ = Command::new(opener).arg(url.as_str()).spawn();
            }
            true
        }
        "steam" => {
            let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
            let _ = Command::new(opener).arg(url.as_str()).spawn();
            true
        }
        _ => false,
    }
}

fn open_folder(path: PathBuf) {
    let _ = fs::create_dir_all(&path);
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(opener).arg(path).spawn();
}

fn main() {
    // Linux: the web view (WebKitGTK) inside the AppImage can disagree with the computer's own graphics drivers, which shows up as the app
    // closing when a game starts or freezing on a busy page. Drawing without the DMA-BUF path avoids it and costs nothing visible.
    // (Set WEBKIT_DISABLE_DMABUF_RENDERER=0 before starting to turn it back on.)
    #[cfg(target_os = "linux")]
    // Only the AppImage carries its own copy of the web view; the .deb and .rpm use the computer's own, which matches its graphics drivers.
    if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .manage(AppState {
            server: Mutex::new(None),
            status: Mutex::new(None),
            #[cfg(target_os = "linux")]
            gfx: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![get_config, use_local, use_remote])
        .setup(|app| {
            // Linux: how the window is drawn, as chosen in the tray menu (Graphics). Standard leaves things as they are.
            #[cfg(target_os = "linux")]
            match read_config(app.handle()).graphics.as_deref() {
                Some("hardware") => {
                    std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
                    std::env::remove_var("WEBKIT_DISABLE_COMPOSITING_MODE");
                }
                Some("software") => {
                    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
                }
                _ => {}
            }
            // The window is made here (not in tauri.conf.json) so that links meant for a new window can be handed to the browser.
            let nav_handle = app.handle().clone();
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            #[cfg(target_os = "linux")]
            if let Ok(dir) = app.path().app_local_data_dir() {
                let dir = dir.join("webview");
                let _ = fs::create_dir_all(&dir);
                win = win.data_directory(dir);
            }
            win
                .title("game-sauce")
                .on_navigation(move |url| !handle_app_link(&nav_handle, url))
                .inner_size(1320.0, 860.0)
                .min_inner_size(820.0, 560.0)
                .on_new_window(|url, _features| {
                    open_external(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Some(ms) = std::env::var("GAMESAUCE_TEST_SWITCH_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms));
                    handle_menu(&handle, "switch");
                });
            }
            let switch = MenuItemBuilder::with_id("switch", "Switch server…").build(app)?;
            let data = MenuItemBuilder::with_id("data", "Open my data folder").build(app)?;
            let setup = MenuItemBuilder::with_id("setup", "Set up emulators…").build(app)?;
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || register_launcher_link(&handle));
            }
            let quit = MenuItemBuilder::with_id("quit", "Quit").accelerator("CmdOrCtrl+Q").build(app)?;

            // Mac: the menu at the top of the screen, as Mac apps have.
            #[cfg(target_os = "macos")]
            {
                let game = SubmenuBuilder::new(app, "game-sauce").item(&switch).item(&setup).item(&data).separator().item(&quit).build()?;
                let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
                app.set_menu(MenuBuilder::new(app).item(&game).item(&edit).build()?)?;
                app.on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()));
            }

            // Windows and Linux: no menu bar in the window; a small icon in the tray (notification area) instead.
            #[cfg(not(target_os = "macos"))]
            {
                let status = MenuItemBuilder::with_id("status", "Not started yet").enabled(false).build(app)?;
                let open = MenuItemBuilder::with_id("open", "Open game-sauce").build(app)?;
                let mut menu = MenuBuilder::new(app).item(&open).separator().item(&status).separator().item(&switch).item(&setup).item(&data);
                #[cfg(target_os = "linux")]
                {
                    let cur = read_config(app.handle()).graphics.unwrap_or_else(|| "standard".into());
                    let mut sub = SubmenuBuilder::new(app, "Graphics (restart to apply)");
                    let mut items = Vec::new();
                    for (k, label) in [("standard", "Standard"), ("hardware", "Hardware (uses the graphics card)"), ("software", "Software (slower, the safest)")] {
                        let it = CheckMenuItemBuilder::with_id(format!("gfx-{k}"), label).checked(cur == k).build(app)?;
                        sub = sub.item(&it);
                        items.push((k.to_string(), it));
                    }
                    *app.state::<AppState>().gfx.lock().unwrap() = items;
                    menu = menu.item(&sub.build()?);
                }
                let menu = menu.separator().item(&quit).build()?;
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
