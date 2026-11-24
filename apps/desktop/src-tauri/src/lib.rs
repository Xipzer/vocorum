// Vocorum's app: the web UI built into a small native shell. See README.md.

mod approval;
mod events;
mod hub;
mod protocol;
mod secrets;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use hub::{Hub, HubConfig};

pub const SCHEME: &str = "hub";
const MAIN: &str = "main";

pub struct State {
  dir: PathBuf,
  hub: RwLock<Option<Arc<Hub>>>,
  events: events::Events,
  pending_link: Mutex<Option<String>>,
  last_alert: Mutex<Option<(String, Option<String>, std::time::Instant)>>,
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
  let name = url.path_segments().and_then(|mut s| s.next_back()).map(|s| percent_decode(s)).unwrap_or_else(|| "file".into());
  let name: String = name.chars().map(|c| if c.is_alphanumeric() || " ._-()".contains(c) { c } else { '_' }).collect();
  let name = name.trim_start_matches('.').to_string();
  let Ok(dir) = app.path().download_dir() else { return };
  let Ok(bytes) = response.bytes().await else { return };
  let mut target = dir.join(if name.is_empty() { "file".into() } else { name.clone() });
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
    .title("Vocorum")
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
  #[cfg(desktop)]
  let builder = builder
    .inner_size(1180.0, 780.0)
    .min_inner_size(380.0, 520.0)
    .background_color(tauri::window::Color(6, 6, 8, 255))
    .disable_drag_drop_handler();
  let window = builder.build()?;
  #[cfg(target_os = "linux")]
  linux_media(&window);
  let state = app.state::<State>();
  let events = state.events.clone();
  tauri::async_runtime::spawn(async move { events.set_hidden(false).await });
  let _ = window;
  Ok(())
}

// WebKitGTK keeps getUserMedia and MediaRecorder behind settings that wry leaves off.
#[cfg(target_os = "linux")]
fn linux_media(window: &tauri::WebviewWindow) {
  let _ = window.with_webview(|webview| {
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(settings) = webview.inner().settings() {
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
      return Ok("Notifications are turned off for Vocorum in the system settings.".into());
    }
  }
  state.events.set_notify(on).await;
  Ok(if on { "Notifications are on for this device." } else { "Notifications are off for this device." }.into())
}

#[cfg(desktop)]
fn tray(app: &AppHandle) -> tauri::Result<()> {
  use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri_plugin_autostart::ManagerExt;
  let open = MenuItem::with_id(app, "open", "Open Vocorum", true, None::<&str>)?;
  let login = CheckMenuItem::with_id(app, "autostart", "Start when I log in", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit Vocorum", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&open, &login, &PredefinedMenuItem::separator(app)?, &quit])?;
  let toggle = login.clone();
  TrayIconBuilder::with_id("tray")
    .icon(app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other("no icon")))?)
    .tooltip("Vocorum")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(move |app, event| match event.id().as_ref() {
      "open" => show_main(app),
      "autostart" => {
        let launcher = app.autolaunch();
        let on = !launcher.is_enabled().unwrap_or(false);
        let _ = if on { launcher.enable() } else { launcher.disable() };
        let _ = toggle.set_checked(launcher.is_enabled().unwrap_or(on));
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        show_main(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let _ = rustls::crypto::ring::default_provider().install_default();
  let mut builder = tauri::Builder::default();
  #[cfg(desktop)]
  {
    builder = builder
      .plugin(tauri_plugin_single_instance::init(|app, args, _| {
        take_link(app, args.iter().filter_map(|a| Url::parse(a).ok()));
        show_main(app);
      }))
      .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build());
  }
  builder
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| protocol::handle(ctx.app_handle(), request, responder))
    .invoke_handler(tauri::generate_handler![pair, sign_in, approve_request, forget_hub, events_subscribe, events_unsubscribe, set_focus, set_alerts])
    .setup(|app| {
      let dir = app.path().app_config_dir()?;
      std::fs::create_dir_all(&dir)?;
      let state = State { dir: dir.clone(), hub: RwLock::new(None), events: Default::default(), pending_link: Mutex::new(None), last_alert: Mutex::new(None) };
      app.manage(state);
      let handle = app.handle().clone();
      if let Some(config) = HubConfig::load(&dir) {
        tauri::async_runtime::block_on(async { app.state::<State>().install(&handle, config).await }).map_err(std::io::Error::other)?;
      }
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let link_handle = handle.clone();
        app.deep_link().on_open_url(move |event| take_link(&link_handle, event.urls()));
        if let Ok(Some(urls)) = app.deep_link().get_current() {
          take_link(&handle, urls);
        }
      }
      #[cfg(desktop)]
      tray(&handle)?;
      let hidden = std::env::args().any(|a| a == "--hidden");
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
      }
      RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
      #[cfg(target_os = "macos")]
      RunEvent::Reopen { .. } => show_main(app),
      _ => {}
    });
}
