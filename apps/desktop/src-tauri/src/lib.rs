// Vocorum's app: the web UI built into a small native shell. See README.md.

mod approval;
mod events;
mod hub;
mod protocol;
mod secrets;
#[cfg(desktop)]
mod updates;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use hub::{Hub, HubConfig};

pub const SCHEME: &str = "hub";
pub(crate) const MAIN: &str = "main";
// A preview build (VOCORUM_PREVIEW at build time) is installed beside the real app under
// its own name and identifier: its own pairing, storage and windows. It stays quiet (no
// system notifications, the real app shows those) and says when it was built.
pub(crate) const PREVIEW: bool = option_env!("VOCORUM_PREVIEW").is_some();
const BUILD_STAMP: Option<&str> = option_env!("VOCORUM_BUILD_STAMP");

// "Vocorum", or the name the build was given (a preview is "Vocorum Preview").
fn app_name(app: &AppHandle) -> String {
  app.config().product_name.clone().unwrap_or_else(|| "Vocorum".into())
}

pub struct State {
  dir: PathBuf,
  hub: RwLock<Option<Arc<Hub>>>,
  events: events::Events,
  pending_link: Mutex<Option<String>>,
  last_alert: Mutex<Option<(String, Option<String>, std::time::Instant)>>,
  #[cfg(desktop)]
  update: Mutex<Option<tauri_plugin_updater::Update>>,
  show_update_check: std::sync::atomic::AtomicBool,
}

impl State {
  pub fn hub(&self) -> Option<Arc<Hub>> {
    self.hub.read().ok().and_then(|h| h.clone())
  }

  async fn install(&self, app: &AppHandle, config: HubConfig) -> Result<(), String> {
    let hub = Arc::new(Hub::new(config, &self.dir)?);
    *self.hub.write().map_err(|e| e.to_string())? = Some(hub.clone());
    if hub.config.signed_out {
      self.events.stop().await;
    } else {
      self.events.start(app.clone(), hub).await;
    }
    Ok(())
  }

  pub async fn set_signed_out(&self, app: &AppHandle, signed_out: bool) {
    let Some(hub) = self.hub() else { return };
    let config = HubConfig { signed_out, ..hub.config.clone() };
    let _ = config.save(&self.dir);
    let _ = self.install(app, config).await;
  }
}

// The page's origin: hub://localhost, served as https://hub.localhost on Windows and Android.
fn app_url() -> Url {
  if cfg!(any(windows, target_os = "android")) {
    Url::parse(&format!("https://{SCHEME}.localhost/")).unwrap()
  } else {
    Url::parse(&format!("{SCHEME}://localhost/")).unwrap()
  }
}

fn own_origin(url: &Url) -> bool {
  let home = app_url();
  url.scheme() == home.scheme() && url.host_str() == home.host_str() && url.port_or_known_default() == home.port_or_known_default()
}

// Links leave the app: web pages open in the default browser; the hub's files are saved to Downloads.
fn open_elsewhere(app: &AppHandle, url: Url) {
  if own_origin(&url) {
    if url.path().starts_with("/attachments/") {
      let app = app.clone();
      tauri::async_runtime::spawn(async move { download(&app, url).await });
    }
    return;
  }
  if matches!(url.scheme(), "https" | "http" | "mailto") {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
  }
}

async fn download(app: &AppHandle, url: Url) {
  let state = app.state::<State>();
  let Some(hub) = state.hub() else { return };
  let path_and_query = match url.query() {
    Some(q) => format!("{}?{}", url.path(), q),
    None => url.path().to_string(),
  };
  let Ok(response) = hub.send(reqwest::Method::GET, &path_and_query, Default::default(), Vec::new()).await else { return };
  if !response.status().is_success() {
    return;
  }
  let name = download_name(url.path_segments().and_then(|mut s| s.next_back()).unwrap_or(""));
  let Ok(dir) = app.path().download_dir() else { return };
  let Ok(bytes) = response.bytes().await else { return };
  let mut target = dir.join(&name);
  let mut n = 1;
  while target.exists() {
    let (stem, ext) = name.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((name.clone(), String::new()));
    target = dir.join(format!("{stem} ({n}){ext}"));
    n += 1;
  }
  if std::fs::write(&target, &bytes).is_ok() {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().reveal_item_in_dir(&target);
  }
}

// A file name that stays inside Downloads, whatever the hub's URL says.
fn download_name(segment: &str) -> String {
  let name: String = percent_decode(segment).chars().map(|c| if c.is_alphanumeric() || " ._-()".contains(c) { c } else { '_' }).collect();
  let name = name.trim_start_matches('.').to_string();
  if name.is_empty() { "file".into() } else { name }
}

fn percent_decode(text: &str) -> String {
  let bytes = text.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(b) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
        out.push(b);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

pub fn show_main(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN) {
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    return;
  }
  if let Err(error) = build_main(app) {
    eprintln!("[vocorum] could not open the window: {error}");
  }
}

fn build_main(app: &AppHandle) -> tauri::Result<()> {
  let mut url = app_url();
  // Opened from an alert in the last half minute: go to its message.
  if let Some((channel, message, at)) = app.state::<State>().last_alert.lock().ok().and_then(|mut l| l.take()) {
    if at.elapsed().as_secs() < 30 && channel.chars().all(|c| c.is_ascii_digit()) {
      let message = message.filter(|m| m.chars().all(|c| c.is_ascii_digit()));
      url.set_query(Some(&match message {
        Some(m) => format!("channel={channel}&message={m}"),
        None => format!("channel={channel}"),
      }));
    }
  }
  let handle = app.clone();
  let opener = app.clone();
  let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::CustomProtocol(url))
    .title(app_name(app))
    .use_https_scheme(true)
    .on_navigation(move |url| {
      if own_origin(url) {
        return true;
      }
      open_elsewhere(&handle, url.clone());
      false
    })
    .on_new_window(move |url, _| {
      open_elsewhere(&opener, url);
      NewWindowResponse::Deny
    })
    .on_permission_request(|_, kind| match kind {
      PermissionKind::Microphone => PermissionResponse::Allow,
      _ => PermissionResponse::Deny,
    });
  let builder = match data_dir() {
    Some(dir) => builder.data_directory(dir.join("webview")),
    None => builder,
  };
  // Apple's web view ignores that folder, so there a test profile gets its own web
  // store by identifier. Without it a test run shares the person's drafts and sign-in.
  #[cfg(any(target_os = "macos", target_os = "ios"))]
  let builder = match data_dir() {
    Some(dir) => {
      use sha2::{Digest, Sha256};
      let hash = Sha256::digest(dir.to_string_lossy().as_bytes());
      let mut id = [0u8; 16];
      id.copy_from_slice(&hash[..16]);
      builder.data_store_identifier(id)
    }
    None => builder,
  };
  #[cfg(desktop)]
  let builder = builder
    .inner_size(1180.0, 780.0)
    .min_inner_size(380.0, 520.0)
    .background_color(tauri::window::Color(6, 6, 8, 255))
    .zoom_hotkeys_enabled(true)
    .disable_drag_drop_handler();
  // The page draws Discord's 32px title bar (TitleBar.tsx): macOS keeps its traffic
  // lights over it, Windows gets the page's own controls. Linux keeps its frame.
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .traffic_light_position(tauri::LogicalPosition::new(12.0, 16.0));
  #[cfg(windows)]
  let builder = builder.decorations(false).shadow(true);
  #[cfg(target_os = "linux")]
  let builder = builder.theme(Some(tauri::Theme::Dark));
  let window = builder.build()?;
  #[cfg(target_os = "linux")]
  linux_media(&window);
  #[cfg(windows)]
  {
    let target = window.clone();
    window.on_window_event(move |event| {
      // Minimising does not always blur the window first.
      match event {
        tauri::WindowEvent::Focused(focused) => background_memory(&target, !focused),
        tauri::WindowEvent::Resized(_) if target.is_minimized().unwrap_or(false) => background_memory(&target, true),
        _ => {}
      }
    });
  }
  let state = app.state::<State>();
  let events = state.events.clone();
  tauri::async_runtime::spawn(async move { events.set_hidden(false).await });
  let _ = window;
  Ok(())
}

// A window left in the background for half a minute asks WebView2 to give memory
// back (its "low" memory target); coming to the front restores the normal target.
#[cfg(windows)]
fn background_memory(window: &tauri::WebviewWindow, background: bool) {
  use std::sync::atomic::{AtomicU64, Ordering};
  static TURN: AtomicU64 = AtomicU64::new(0);
  let turn = TURN.fetch_add(1, Ordering::SeqCst) + 1;
  let window = window.clone();
  tauri::async_runtime::spawn(async move {
    if background {
      tokio::time::sleep(std::time::Duration::from_secs(30)).await;
      if TURN.load(Ordering::SeqCst) != turn {
        return;
      }
    }
    let _ = window.with_webview(move |webview| unsafe {
      use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
      use windows::core::Interface;
      let level = if background { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
      if let Ok(core) = webview.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
        let _ = core.SetMemoryUsageTargetLevel(level);
      }
    });
  });
}

// WebKitGTK keeps getUserMedia and MediaRecorder behind settings that wry leaves off.
// It also composites on the GPU by default, and where the GPU path falls back to
// software GL (VMs, WSL, some drivers) every animation frame costs whole cores; a
// chat window needs none of it. VOCORUM_GPU=1 turns it back on.
#[cfg(target_os = "linux")]
fn linux_media(window: &tauri::WebviewWindow) {
  let gpu = std::env::var("VOCORUM_GPU").is_ok_and(|v| v == "1");
  let _ = window.with_webview(move |webview| {
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(settings) = webview.inner().settings() {
      if !gpu {
        settings.set_hardware_acceleration_policy(webkit2gtk::HardwareAccelerationPolicy::Never);
      }
      settings.set_enable_media_stream(true);
      settings.set_enable_mediasource(true);
      settings.set_enable_media_capabilities(true);
      settings.set_enable_developer_extras(cfg!(debug_assertions));
    }
  });
}

// --- Commands the page calls

#[tauri::command]
async fn pair(app: AppHandle, state: tauri::State<'_, State>, link: String) -> Result<(), String> {
  let link = hub::parse_link(&link)?;
  if let Some(old) = state.hub() {
    forget_keys(&state, &old.config);
  }
  let config = hub::pair(&state.dir, &link).await?;
  if let Ok(mut pending) = state.pending_link.lock() {
    *pending = None;
  }
  state.install(&app, config).await?;
  let hub = state.hub().ok_or("not paired")?;
  hub.token().await.map_err(|e| e.message())?;
  Ok(())
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: tauri::State<'_, State>) -> Result<(), String> {
  let hub = state.hub().ok_or("This app is not paired with a hub yet.")?;
  state.set_signed_out(&app, false).await;
  let hub = state.hub().unwrap_or(hub);
  hub.token().await.map(|_| ()).map_err(|e| e.message())
}

#[tauri::command]
async fn forget_hub(state: tauri::State<'_, State>) -> Result<(), String> {
  if let Some(hub) = state.hub() {
    forget_keys(&state, &hub.config);
  }
  HubConfig::remove(&state.dir);
  state.events.stop().await;
  *state.hub.write().map_err(|e| e.to_string())? = None;
  Ok(())
}

fn forget_keys(state: &State, config: &HubConfig) {
  secrets::delete(&state.dir, &config.key_id);
  if let Some(tag) = &config.approval_tag {
    approval::delete(tag);
  }
}

#[tauri::command]
async fn approve_request(state: tauri::State<'_, State>, id: String) -> Result<Value, String> {
  let hub = state.hub().ok_or("Not signed in")?;
  hub.approve(&id).await.map_err(|e| e.message())
}

#[tauri::command]
async fn events_subscribe(state: tauri::State<'_, State>, channel: Channel<Value>) -> Result<(), String> {
  state.events.subscribe(channel).await;
  Ok(())
}

#[tauri::command]
async fn events_unsubscribe(state: tauri::State<'_, State>) -> Result<(), String> {
  state.events.unsubscribe().await;
  Ok(())
}

// The page's title bar buttons (Windows) and dragging (both).
#[tauri::command]
fn window_control(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
  match action.as_str() {
    "minimize" => window.minimize(),
    "toggle_maximize" => {
      if window.is_maximized().unwrap_or(false) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
    "close" => window.close(),
    "drag" => window.start_dragging(),
    _ => return Err("unknown window action".into()),
  }
  .map_err(|e| e.to_string())
}

// The window's own title follows the page's ("#channel | Server") for the taskbar and Alt+Tab.
#[tauri::command]
fn window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
  window.set_title(&title.chars().take(200).collect::<String>()).map_err(|e| e.to_string())
}

#[tauri::command]
fn window_maximized(window: tauri::WebviewWindow) -> bool {
  window.is_maximized().unwrap_or(false)
}

#[tauri::command]
async fn set_focus(state: tauri::State<'_, State>, focus: Value) -> Result<(), String> {
  state.events.set_focus(focus).await;
  Ok(())
}

#[tauri::command]
async fn set_alerts(app: AppHandle, state: tauri::State<'_, State>, on: bool) -> Result<String, String> {
  use tauri_plugin_notification::{NotificationExt, PermissionState};
  if on && app.notification().permission_state().map_err(|e| e.to_string())? != PermissionState::Granted {
    if app.notification().request_permission().map_err(|e| e.to_string())? != PermissionState::Granted {
      let settings = if cfg!(windows) { "Windows Settings" } else { "System Settings" };
      return Ok(format!("Notifications for Vocorum are off in {settings}. Turn them on there first."));
    }
  }
  state.events.set_notify(on).await;
  Ok(if on { "Notifications are on for this device." } else { "Notifications are off for this device." }.into())
}

#[cfg(desktop)]
fn tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
  use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
  use tauri_plugin_autostart::ManagerExt;
  let name = app_name(app);
  let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
  let login = CheckMenuItem::with_id(app, "autostart", "Open at login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;
  let built = BUILD_STAMP.map(|stamp| format!(" · {stamp}")).unwrap_or_default();
  let version = MenuItem::with_id(app, "version", format!("{name} {}{built}", app.package_info().version), false, None::<&str>)?;
  let check = MenuItem::with_id(app, "check", "Check for Updates…", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, "update", "Restart to update", false, None::<&str>)?;
  let menu = Menu::with_items(app, &[&version, &open, &check, &restart, &login, &separator, &quit])?;
  app.manage(UpdateMenu { restart });
  Ok(menu)
}

#[cfg(desktop)]
struct UpdateMenu {
  restart: tauri::menu::MenuItem<tauri::Wry>,
}

#[cfg(desktop)]
pub fn set_update_item(app: &AppHandle, version: Option<&str>) {
  if let Some(menu) = app.try_state::<UpdateMenu>() {
    let label = version.map_or_else(|| "Restart to update".into(), |v| format!("Restart to update ({v})"));
    let _ = menu.restart.set_text(label);
    let _ = menu.restart.set_enabled(version.is_some());
  }
}

#[cfg(desktop)]
fn tray(app: &AppHandle) -> tauri::Result<()> {
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri_plugin_autostart::ManagerExt;
  #[cfg(target_os = "macos")]
  let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
  #[cfg(target_os = "windows")]
  let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-windows.png"))?;
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let icon = app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other("no icon")))?;
  TrayIconBuilder::with_id("tray")
    .icon(icon)
    .icon_as_template(cfg!(target_os = "macos"))
    .tooltip(app_name(app))
    .menu(&tray_menu(app)?)
    .show_menu_on_left_click(cfg!(target_os = "macos"))
    .on_menu_event(move |app, event| match event.id().as_ref() {
      "open" => show_main(app),
      "autostart" => {
        let launcher = app.autolaunch();
        let on = !launcher.is_enabled().unwrap_or(false);
        let _ = if on { launcher.enable() } else { launcher.disable() };
      }
      "check" => open_update_check(app),
      "update" => updates::install(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if !cfg!(target_os = "macos") && matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
        show_main(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(())
}

#[cfg(desktop)]
fn open_update_check(app: &AppHandle) {
  app.state::<State>().show_update_check.store(true, std::sync::atomic::Ordering::Release);
  show_main(app);
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.eval("window.dispatchEvent(new Event('vocorum-update-check'))");
  }
}

#[tauri::command]
fn take_update_check(state: tauri::State<'_, State>) -> bool {
  state.show_update_check.swap(false, std::sync::atomic::Ordering::AcqRel)
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<Value, String> {
  #[cfg(desktop)]
  return updates::report(&app).await;
  #[cfg(mobile)]
  { let _ = app; Err("Check for updates in the App Store.".into()) }
}

// "Restart to update" in the update dialog: the same action as the tray item.
#[tauri::command]
fn install_app_update(app: AppHandle, state: tauri::State<'_, State>) -> Result<(), String> {
  #[cfg(desktop)]
  {
    if state.update.lock().map_err(|_| "Check again.")?.is_none() {
      return Err("No update is waiting. Check again.".into());
    }
    updates::install(&app);
    Ok(())
  }
  #[cfg(mobile)]
  { let _ = (app, state); Err("Update Vocorum in the App Store.".into()) }
}

// Reads the "Update automatically" switch, or sets it when given a value.
#[tauri::command]
fn auto_update(app: AppHandle, enabled: Option<bool>) -> Result<bool, String> {
  #[cfg(desktop)]
  {
    if let Some(on) = enabled {
      updates::set_automatic(&app, on)?;
    }
    Ok(updates::automatic(&app))
  }
  #[cfg(mobile)]
  { let _ = (app, enabled); Ok(false) }
}

fn take_link(app: &AppHandle, urls: impl IntoIterator<Item = Url>) {
  for url in urls {
    if url.scheme() == "vocorum" && url.host_str() == Some("pair") {
      if let Ok(mut pending) = app.state::<State>().pending_link.lock() {
        *pending = Some(url.to_string());
      }
      // The page shows it in the pairing form; nothing pairs without a click.
      if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval("window.dispatchEvent(new Event('vocorum-pair-link'))");
      }
      show_main(app);
    }
  }
}

// VOCORUM_DATA_DIR keeps everything of one app run (pairing, web storage) in that
// folder, so the end-to-end tests never touch the person's own app.
fn data_dir() -> Option<std::path::PathBuf> {
  std::env::var_os("VOCORUM_DATA_DIR").filter(|d| !d.is_empty()).map(std::path::PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let _ = rustls::crypto::ring::default_provider().install_default();
  #[cfg_attr(mobile, allow(unused_mut))]
  let mut builder = tauri::Builder::default();
  #[cfg(target_os = "macos")]
  {
    builder = builder.menu(|app| {
      use tauri::menu::{Menu, MenuItem, MenuItemKind};
      let menu = Menu::default(app)?;
      if let Some(MenuItemKind::Submenu(application)) = menu.items()?.first() {
        application.insert(&MenuItem::with_id(app, "app-check-updates", "Check for Updates…", true, None::<&str>)?, 1)?;
      }
      Ok(menu)
    }).on_menu_event(|app, event| {
      if event.id().as_ref() == "app-check-updates" { open_update_check(app); }
    });
  }
  #[cfg(desktop)]
  {
    // A test profile (see data_dir) runs beside the person's own app, not into it.
    if data_dir().is_none() {
      builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        take_link(app, args.iter().filter_map(|a| Url::parse(a).ok()));
        show_main(app);
      }));
    }
    builder = builder
      .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build())
      .plugin(tauri_plugin_updater::Builder::new().build());
  }
  builder
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| protocol::handle(ctx.app_handle(), request, responder))
    .invoke_handler(tauri::generate_handler![pair, sign_in, approve_request, forget_hub, events_subscribe, events_unsubscribe, set_focus, set_alerts, window_control, window_maximized, window_title, take_update_check, check_app_update, install_app_update, auto_update])
    .setup(|app| {
      let dir = match data_dir() {
        Some(dir) => dir.join("config"),
        None => app.path().app_config_dir()?,
      };
      std::fs::create_dir_all(&dir)?;
      let state = State { dir: dir.clone(), hub: RwLock::new(None), events: Default::default(), pending_link: Mutex::new(None),
        last_alert: Mutex::new(None),
        show_update_check: Default::default(),
        #[cfg(desktop)]
        update: Mutex::new(None),
      };
      app.manage(state);
      let handle = app.handle().clone();
      // A saved hub that cannot be used (damaged record) must not stop the app from
      // opening: it starts unpaired and shows the pairing screen. The record stays on disk.
      if let Some(config) = HubConfig::load(&dir) {
        if let Err(error) = tauri::async_runtime::block_on(async { app.state::<State>().install(&handle, config).await }) {
          eprintln!("[vocorum] the saved hub could not be loaded: {error}");
        }
      }
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let link_handle = handle.clone();
        app.deep_link().on_open_url(move |event| take_link(&link_handle, event.urls()));
        if let Ok(Some(urls)) = app.deep_link().get_current() {
          take_link(&handle, urls);
        }
      }
      // `--pair <link>` from a terminal pairs without the card (scripted setups). Links
      // from browsers arrive as deep links instead and always wait for a click.
      let argv: Vec<String> = std::env::args().collect();
      // A preview can be started on one conversation (`--open <channel id>`), to compare it
      // with the real app on the same page. It travels the way an alert's conversation does.
      if PREVIEW {
        if let Some(channel) = argv.iter().position(|a| a == "--open").and_then(|i| argv.get(i + 1)).cloned() {
          if let Ok(mut last) = app.state::<State>().last_alert.lock() {
            *last = Some((channel, None, std::time::Instant::now()));
          }
        }
      }
      // Ignored once paired: an update restarts the app with the same arguments.
      let paired = app.state::<State>().hub().is_some();
      if let Some(link) = argv.iter().position(|a| a == "--pair").and_then(|i| argv.get(i + 1)).cloned().filter(|_| !paired) {
        let pair_handle = handle.clone();
        tauri::async_runtime::spawn(async move {
          let state = pair_handle.state::<State>();
          let result = match hub::parse_link(&link) {
            Ok(link) => match hub::pair(&state.dir, &link).await {
              Ok(config) => state.install(&pair_handle, config).await,
              Err(error) => Err(error),
            },
            Err(error) => Err(error),
          };
          match result {
            Ok(()) => {
              eprintln!("[vocorum] paired");
              if let Some(window) = pair_handle.get_webview_window(MAIN) {
                let _ = window.eval("location.reload()");
              }
            }
            Err(error) => eprintln!("[vocorum] pairing failed: {error}"),
          }
        });
      }
      #[cfg(desktop)]
      {
        tray(&handle)?;
        updates::start(handle.clone());
      }
      // Set by an automatic update that ran while the window was closed.
      let after_update = std::env::var("VOCORUM_START_HIDDEN").is_ok_and(|v| v == "1");
      std::env::remove_var("VOCORUM_START_HIDDEN");
      let hidden = after_update || std::env::args().any(|a| a == "--hidden");
      if !hidden {
        show_main(&handle);
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Vocorum")
    .run(|app, event| match event {
      // Closing the window frees it entirely; the tray and the alert socket stay.
      RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == MAIN => {
        let events = app.state::<State>().events.clone();
        tauri::async_runtime::spawn(async move { events.set_hidden(true).await });
        // With "Update automatically" on, a waiting update installs now that nothing is open.
        #[cfg(desktop)]
        updates::install_if_automatic(app);
      }
      RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
      #[cfg(target_os = "macos")]
      RunEvent::Reopen { .. } => show_main(app),
      _ => {}
    });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_app_origin_is_its_own() {
    assert!(own_origin(&app_url().join("/channels/1").unwrap()));
    for other in ["https://hub.localhost.example/", "hub://elsewhere/", "http://localhost/", "https://example.com/", "file:///etc/passwd"] {
      assert!(!own_origin(&Url::parse(other).unwrap()), "{other}");
    }
  }

  #[test]
  fn download_names_stay_in_downloads() {
    assert_eq!(download_name("report%20(1).pdf"), "report (1).pdf");
    assert_eq!(download_name("..%2F..%2F.bashrc"), "_.._.bashrc");
    assert_eq!(download_name("%2e%2e"), "file");
    assert_eq!(download_name("a%5Cb%00c"), "a_b_c");
    assert_eq!(download_name(""), "file");
    assert!(!download_name("....%2Fetc%2Fpasswd").contains(['/', '\\']));
  }
}
