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

// Checks shortly after start and then every six hours; a found update waits for
// the person to choose "Restart to update" in the tray.
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
          // VOCORUM_UPDATE_AUTO=1 installs at once, for machines nobody sits at.
          Ok(Some(update)) if std::env::var("VOCORUM_UPDATE_AUTO").is_ok_and(|v| v == "1") => {
            if let Ok(mut pending) = app.state::<State>().update.lock() {
              *pending = Some(update);
            }
            install(&app);
          }
          Ok(Some(update)) => offer(&app, update),
          Ok(None) => {}
          Err(error) => eprintln!("[vocorum] update check: {error}"),
        }
      }
      tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
    }
  });
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
