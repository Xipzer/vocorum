// Updates come only from the hub the app is paired with, over the same pinned
// TLS and bearer token as everything else, and install only if they carry a
// valid signature from the publisher key built into this app
// (VOCORUM_UPDATER_PUBKEY at build time). Builds without that key never update.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::hub::Hub;
use crate::State;

pub const PUBKEY: Option<&str> = option_env!("VOCORUM_UPDATER_PUBKEY");

async fn check(app: &AppHandle, hub: &Arc<Hub>) -> Result<Option<Update>, String> {
  let Some(pubkey) = PUBKEY.filter(|k| !k.is_empty()) else { return Ok(None) };
  let token = hub.token().await.map_err(|e| e.message())?;
  let endpoint = format!("{}/client/app/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?bundle={{{{bundle_type}}}}", hub.config.origin());
  let tls = (*hub.tls).clone();
  let name = hub.config.name.clone();
  let socket = hub.config.socket()?;
  app
    .updater_builder()
    .pubkey(pubkey)
    .endpoints(vec![endpoint.parse().map_err(|e: url::ParseError| e.to_string())?])
    .map_err(|e| e.to_string())?
    .header("authorization", format!("Bearer {token}"))
    .map_err(|e| e.to_string())?
    .timeout(Duration::from_secs(300))
    .configure_client(move |client| {
      client
        .tls_backend_preconfigured(tls.clone())
        .resolve(&name, socket)
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
    })
    .build()
    .map_err(|e| e.to_string())?
    .check()
    .await
    .map_err(|e| e.to_string())
}

// Checks shortly after start and then every hour: one small request to the paired
// hub over the connection the app already has. A found update waits for the
// person to choose "Restart to update", unless they turned automatic updates on.
pub fn start(app: AppHandle) {
  if PUBKEY.is_none_or(str::is_empty) {
    return;
  }
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
      let state = app.state::<State>();
      if let Some(hub) = state.hub().filter(|h| !h.config.signed_out) {
        match check(&app, &hub).await {
          Ok(Some(update)) => {
            offer(&app, update);
            install_if_automatic(&app);
          }
          Ok(None) => {}
          Err(error) => eprintln!("[vocorum] update check: {error}"),
        }
      }
      tokio::time::sleep(Duration::from_secs(3600)).await;
    }
  });
}

// "Update automatically" in Settings is a marker file next to the hub record.
fn automatic_file(app: &AppHandle) -> std::path::PathBuf {
  app.state::<State>().dir.join("auto-update")
}

pub fn automatic(app: &AppHandle) -> bool {
  automatic_file(app).exists()
}

pub fn set_automatic(app: &AppHandle, on: bool) -> Result<(), String> {
  let file = automatic_file(app);
  if on {
    std::fs::write(&file, b"").map_err(|e| e.to_string())?;
    install_if_automatic(app);
  } else if file.exists() {
    std::fs::remove_file(&file).map_err(|e| e.to_string())?;
  }
  Ok(())
}

// Installs a waiting update without asking: always with VOCORUM_UPDATE_AUTO=1 (machines
// nobody sits at), and with the Settings switch only while the window is closed, so a
// restart never takes a message someone is writing.
pub fn install_if_automatic(app: &AppHandle) {
  let unattended = std::env::var("VOCORUM_UPDATE_AUTO").is_ok_and(|v| v == "1");
  let closed = app.get_webview_window(crate::MAIN).is_none();
  if unattended || (automatic(app) && closed) {
    // The app comes back the way it was: in the tray, without opening a window.
    if closed {
      std::env::set_var("VOCORUM_START_HIDDEN", "1");
    }
    install(app);
  }
}

// A check only offers the build. Installation is a separate menu action.
pub async fn report(app: &AppHandle) -> Result<serde_json::Value, String> {
  if PUBKEY.is_none_or(str::is_empty) {
    return Err("This build has no update key. Use an official build from your hub.".into());
  }
  let hub = app.state::<State>().hub().filter(|h| !h.config.signed_out)
    .ok_or("Pair and sign in to your hub, then check again.")?;
  let result = check(app, &hub).await.map_err(|_| "Couldn't check for updates. Connect to your hub and try again.")?;
  if !app.state::<State>().hub().is_some_and(|h| Arc::ptr_eq(&h, &hub)) {
    return Err("Your hub changed. Check again.".into());
  }
  if let Some(update) = result {
    let result = serde_json::json!({"version":update.version,"notes":update.body});
    offer(app, update);
    Ok(result)
  } else {
    if let Ok(mut pending) = app.state::<State>().update.lock() { *pending = None; }
    crate::set_update_item(app, None);
    Ok(serde_json::Value::Null)
  }
}

fn offer(app: &AppHandle, update: Update) {
  let state = app.state::<State>();
  let Ok(mut pending) = state.update.lock() else { return };
  let fresh = pending.as_ref().is_none_or(|p| p.version != update.version);
  let version = update.version.clone();
  *pending = Some(update);
  drop(pending);
  if fresh {
    crate::set_update_item(app, Some(&version));
    use tauri_plugin_notification::NotificationExt;
    let place = if cfg!(target_os = "macos") { "menu bar" } else { "tray" };
    let _ = app.notification().builder().title("Update ready").body(format!("Restart Vocorum from the {place} menu to get version {version}.")).show();
  }
}

pub fn install(app: &AppHandle) {
  let Some(update) = app.state::<State>().update.lock().ok().and_then(|mut p| p.take()) else { return };
  let app = app.clone();
  crate::set_update_item(&app, None);
  // A .deb installs as root, so the system asks for a password: say why first.
  #[cfg(target_os = "linux")]
  if matches!(tauri::utils::platform::bundle_type(), Some(tauri::utils::config::BundleType::Deb)) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().body(format!("Vocorum needs your password to install version {}.", update.version)).show();
  }
  tauri::async_runtime::spawn(async move {
    match update.download_and_install(|_, _| {}, || {}).await {
      Ok(()) => app.restart(),
      Err(error) => {
        eprintln!("[vocorum] update failed: {error}");
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Update didn't install").body("Vocorum will try again later.").show();
      }
    }
  });
}
