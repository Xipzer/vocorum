// The hub's event socket, held by the app rather than the page: it stays open
// with the window closed, so alerts still arrive while only the tray icon runs.
// The page subscribes with an IPC channel and gets the same {t, d} frames the
// browser socket would give it, plus CLOSED when the connection drops.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::hub::Hub;

#[derive(Default)]
struct Inner {
  page: Option<Channel<Value>>,
  focus: Option<Value>,
  hidden: bool,
  outbox: Option<mpsc::UnboundedSender<String>>,
  connected: bool,
  task: Option<tauri::async_runtime::JoinHandle<()>>,
  notify: bool,
}

#[derive(Clone, Default)]
pub struct Events(Arc<Mutex<Inner>>);

impl Events {
  pub async fn subscribe(&self, channel: Channel<Value>) {
    let mut inner = self.0.lock().await;
    if inner.connected {
      let _ = channel.send(json!({ "t": "HELLO", "d": {} }));
    }
    inner.page = Some(channel);
  }

  pub async fn unsubscribe(&self) {
    self.0.lock().await.page = None;
  }

  pub async fn set_notify(&self, on: bool) {
    self.0.lock().await.notify = on;
  }

  // Where the page is and whether it is in view; the hub uses it for presence and to hold alerts.
  pub async fn set_focus(&self, focus: Value) {
    #[cfg(windows)]
    if focus.get("visible").and_then(Value::as_bool) == Some(true) {
      if let Some(channel) = focus.get("channel_id").and_then(Value::as_str) {
        toast::clear(channel);
      }
    }
    let mut inner = self.0.lock().await;
    inner.focus = Some(focus);
    send_focus(&inner);
  }

  // The window was closed to the tray (true) or opened again.
  pub async fn set_hidden(&self, hidden: bool) {
    let mut inner = self.0.lock().await;
    inner.hidden = hidden;
    if hidden {
      inner.page = None;
    }
    send_focus(&inner);
  }

  pub async fn stop(&self) {
    let mut inner = self.0.lock().await;
    if let Some(task) = inner.task.take() {
      task.abort();
    }
    inner.outbox = None;
    inner.connected = false;
  }

  pub async fn start(&self, app: AppHandle, hub: Arc<Hub>) {
    self.stop().await;
    let events = self.clone();
    let task = tauri::async_runtime::spawn(async move { events.run(app, hub).await });
    let mut inner = self.0.lock().await;
    inner.notify = true;
    inner.task = Some(task);
  }

  async fn run(&self, app: AppHandle, hub: Arc<Hub>) {
    let mut delay = Duration::from_millis(500);
    loop {
      match self.session(&app, &hub).await {
        Ok(()) => delay = Duration::from_millis(500),
        Err(error) => eprintln!("[vocorum] event socket: {error}"),
      }
      {
        let mut inner = self.0.lock().await;
        inner.connected = false;
        inner.outbox = None;
        if let Some(page) = &inner.page {
          let _ = page.send(json!({ "t": "CLOSED", "d": {} }));
        }
      }
      tokio::time::sleep(delay).await;
      delay = (delay * 2).min(Duration::from_secs(15));
    }
  }

  async fn session(&self, app: &AppHandle, hub: &Hub) -> Result<(), String> {
    let token = hub.token().await.map_err(|e| e.message())?;
    let url = format!("wss://{}:{}/client/events", hub.config.name, hub.config.port);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("authorization", format!("Bearer {token}").parse().map_err(|_| "bad token")?);
    let tcp = tokio::time::timeout(Duration::from_secs(8), tokio::net::TcpStream::connect(hub.config.socket()?))
      .await
      .map_err(|_| "connect timed out")?
      .map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    let connector = tokio_tungstenite::Connector::Rustls(hub.tls.clone());
    let (socket, _) = match tokio_tungstenite::client_async_tls_with_config(request, tcp, None, Some(connector)).await {
      Ok(pair) => pair,
      Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 401 => {
        hub.invalidate(&token).await;
        return Err("signed out, signing in again".into());
      }
      Err(error) => return Err(error.to_string()),
    };
    let (mut write, mut read) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    self.0.lock().await.outbox = Some(tx);
    // The hub's own pings keep it alive; this catches a silently dead link (sleep, Wi-Fi change).
    let mut idle = tokio::time::interval(Duration::from_secs(30));
    idle.tick().await;
    let mut quiet = 0u8;
    loop {
      tokio::select! {
        frame = read.next() => {
          quiet = 0;
          match frame {
            Some(Ok(Message::Text(text))) => self.dispatch(app, text.as_str()).await,
            Some(Ok(Message::Ping(data))) => { let _ = write.send(Message::Pong(data)).await; }
            Some(Ok(Message::Close(_))) | None => return Ok(()),
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(error.to_string()),
          }
        }
        out = rx.recv() => match out {
          Some(text) => write.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
          None => return Ok(()),
        },
        _ = idle.tick() => {
          quiet += 1;
          if quiet > 2 { return Err("no traffic for 90 seconds".into()); }
          write.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
        }
      }
    }
  }

  async fn dispatch(&self, app: &AppHandle, text: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
    let kind = frame.get("t").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut inner = self.0.lock().await;
    if kind == "HELLO" {
      inner.connected = true;
      send_focus(&inner);
    }
    if kind == "NOTIFY" {
      if inner.notify {
        notify(app, frame.get("d").cloned().unwrap_or(Value::Null));
      }
      return;
    }
    if let Some(page) = &inner.page {
      if page.send(frame).is_err() {
        inner.page = None;
      }
    }
  }
}

fn send_focus(inner: &Inner) {
  let Some(outbox) = &inner.outbox else { return };
  let mut focus = inner.focus.clone().unwrap_or_else(|| json!({ "channel_id": null, "visible": true }));
  if inner.hidden || inner.page.is_none() {
    focus["visible"] = json!(false);
  }
  let _ = outbox.send(json!({ "op": "focus", "d": focus }).to_string());
}

fn notify(app: &AppHandle, d: Value) {
  use tauri_plugin_notification::NotificationExt;
  let text = |key: &str| d.get(key).and_then(Value::as_str).unwrap_or_default().chars().take(400).collect::<String>();
  let title = text("title");
  let title = if title.is_empty() { "Vocorum".to_string() } else { title };
  #[cfg(windows)]
  let shown = toast::show(&app.config().identifier, &title, &text("body"), &text("channel_id")).is_some();
  #[cfg(not(windows))]
  let shown = false;
  if !shown {
    let _ = app.notification().builder().title(title).body(text("body")).show();
  }
  if let Some(state) = app.try_state::<crate::State>() {
    let target = d.get("channel_id").and_then(Value::as_str).map(str::to_string);
    if let Ok(mut last) = state.last_alert.lock() {
      *last = target.map(|c| (c, d.get("message_id").and_then(Value::as_str).map(str::to_string), std::time::Instant::now()));
    }
  }
}

// Windows toasts carry the channel as their tag: a new alert from a channel replaces
// the one before it in Action Center, and opening the channel clears it, as Discord
// does. Only the installed app has the app id Windows needs; the plugin covers the rest.
#[cfg(windows)]
mod toast {
  use windows::core::HSTRING;
  use windows::Data::Xml::Dom::XmlDocument;
  use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

  const GROUP: &str = "vocorum";

  // The identifier from tauri.conf.json, which the installer registers as the app id.
  const APP_ID: &str = "dev.xipz.vocorum";

  fn app_id() -> Option<HSTRING> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_string_lossy().to_string();
    let dev = dir.ends_with("target\\debug") || dir.ends_with("target\\release");
    (!dev).then(|| HSTRING::from(APP_ID))
  }

  fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
  }

  pub fn show(identifier: &str, title: &str, body: &str, channel: &str) -> Option<()> {
    let id = app_id().filter(|id| *id == HSTRING::from(identifier))?;
    let xml = XmlDocument::new().ok()?;
    xml.LoadXml(&HSTRING::from(format!(
      "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
      escape(title),
      escape(body)
    )))
    .ok()?;
    let toast = ToastNotification::CreateToastNotification(&xml).ok()?;
    toast.SetGroup(&HSTRING::from(GROUP)).ok()?;
    if !channel.is_empty() {
      toast.SetTag(&HSTRING::from(channel.chars().take(64).collect::<String>())).ok()?;
    }
    ToastNotificationManager::CreateToastNotifierWithId(&id).ok()?.Show(&toast).ok()
  }

  pub fn clear(channel: &str) {
    if let Some(id) = app_id() {
      if let Ok(history) = ToastNotificationManager::History() {
        let _ = history.RemoveGroupedTagWithId(&HSTRING::from(channel), &HSTRING::from(GROUP), &id);
      }
    }
  }
}
