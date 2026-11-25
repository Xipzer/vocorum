// The page's only origin (hub://localhost, or https://hub.localhost on Windows).
// The UI comes from the files built into the app; /client/* and /attachments/*
// are passed to the hub from Rust, so the page keeps its relative URLs and
// never holds a credential. Nothing else is reachable.

use std::borrow::Cow;

use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeResponder};

use crate::hub::HubError;
use crate::State;

// The web app's policy without frames (no remote players inside the app) and with
// Tauri's IPC endpoints. Images from Discord's CDN stay, as in the browser.
pub const CSP: &str = "default-src 'self'; img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://images-ext-1.discordapp.net https://images-ext-2.discordapp.net https://i.ytimg.com; media-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net; connect-src 'self' ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// Request headers the hub may see; everything else (cookies included) is dropped.
const FORWARD: [&str; 6] = ["content-type", "range", "if-none-match", "if-modified-since", "accept", "accept-language"];
// Response headers the page may see; Set-Cookie never reaches it.
const RETURN: [&str; 11] = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "content-disposition",
  "content-security-policy",
  "x-content-type-options",
  "retry-after",
];

// Open-ended media ranges ("bytes=N-") are capped so a long video is never held
// in memory whole; players ask for the next piece themselves.
const RANGE_CAP: u64 = 4 * 1024 * 1024;
const BODY_LIMIT: usize = 64 * 1024 * 1024;

fn reply(status: StatusCode, content_type: &str, body: impl Into<Cow<'static, [u8]>>) -> Response<Cow<'static, [u8]>> {
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, content_type)
    .header(header::CACHE_CONTROL, "no-store")
    .header("x-content-type-options", "nosniff")
    .body(body.into())
    .unwrap()
}

fn json_error(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
  reply(status, "application/json", serde_json::json!({ "error": message }).to_string().into_bytes())
}

pub fn handle(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
  let path = request.uri().path().to_string();
  if path.starts_with("/client/") || path.starts_with("/attachments/") {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { responder.respond(proxy(&app, request).await) });
    return;
  }
  if path == "/app/info" {
    return responder.respond(info(app));
  }
  responder.respond(asset(app, &path));
}

fn asset(app: &AppHandle, path: &str) -> Response<Cow<'static, [u8]>> {
  // The PWA's service worker and manifest mean nothing inside the app.
  if path == "/sw.js" || path == "/manifest.webmanifest" {
    return reply(StatusCode::NOT_FOUND, "text/plain", &b""[..]);
  }
  let Some(asset) = app.asset_resolver().get(path.to_string()) else {
    return reply(StatusCode::NOT_FOUND, "text/plain", &b"Not found"[..]);
  };
  let html = asset.mime_type.starts_with("text/html");
  let mut response = Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, asset.mime_type.as_str())
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header(header::CACHE_CONTROL, if html { "no-cache" } else { "max-age=31536000, immutable" });
  if html {
    response = response.header("content-security-policy", asset.csp_header.as_deref().unwrap_or(CSP));
  }
  response.body(Cow::Owned(asset.bytes)).unwrap()
}

fn info(app: &AppHandle) -> Response<Cow<'static, [u8]>> {
  let state = app.state::<State>();
  let hub = state.hub();
  let pending = state.pending_link.lock().ok().and_then(|l| l.clone());
  let body = serde_json::json!({
    "version": app.package_info().version.to_string(),
    "platform": std::env::consts::OS,
    "paired": hub.is_some(),
    "signedOut": hub.as_ref().map(|h| h.config.signed_out).unwrap_or(false),
    "origin": hub.as_ref().map(|h| h.config.origin()),
    "device": hub.as_ref().map(|h| h.config.device_name.clone()),
    "pendingLink": pending,
  });
  reply(StatusCode::OK, "application/json", body.to_string().into_bytes())
}

fn capped_range(value: &str) -> Option<String> {
  let spec = value.strip_prefix("bytes=")?;
  let (start, end) = spec.split_once('-')?;
  if !end.is_empty() || spec.contains(',') {
    return None;
  }
  let start: u64 = start.parse().ok()?;
  Some(format!("bytes={}-{}", start, start + RANGE_CAP - 1))
}

async fn proxy(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
  let state = app.state::<State>();
  let path = request.uri().path().to_string();
  let path_and_query = request.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or(path.clone());
  let Some(hub) = state.hub() else {
    if path == "/client/auth/status" {
      return reply(StatusCode::OK, "application/json", &br#"{"signedIn":false,"device":null}"#[..]);
    }
    return json_error(StatusCode::UNAUTHORIZED, "Not signed in");
  };
  if hub.config.signed_out {
    if path == "/client/auth/status" {
      return reply(StatusCode::OK, "application/json", &br#"{"signedIn":false,"device":null}"#[..]);
    }
    return json_error(StatusCode::UNAUTHORIZED, "Not signed in");
  }
  // Signing out keeps the device key: the user signs in again with one click.
  if path == "/client/auth/logout" {
    if let Some(token) = hub.forget_token().await {
      let _ = hub.http.post(hub.url("/client/auth/logout")).bearer_auth(token).json(&serde_json::json!({})).send().await;
    }
    state.set_signed_out(app, true).await;
    return reply(StatusCode::OK, "application/json", &br#"{"ok":true}"#[..]);
  }
  if path.starts_with("/client/auth/") && path != "/client/auth/status" {
    return json_error(StatusCode::NOT_FOUND, "Not found");
  }
  let Ok(method) = reqwest::Method::from_bytes(request.method().as_str().as_bytes()) else {
    return json_error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
  };
  let mut headers = reqwest::header::HeaderMap::new();
  for name in FORWARD {
    if let Some(value) = request.headers().get(name) {
      let value = if name == "range" && path.starts_with("/attachments/") {
        value.to_str().ok().and_then(capped_range).and_then(|v| HeaderValue::from_str(&v).ok()).unwrap_or_else(|| value.clone())
      } else {
        value.clone()
      };
      if let (Ok(n), Ok(v)) = (reqwest::header::HeaderName::from_bytes(name.as_bytes()), reqwest::header::HeaderValue::from_bytes(value.as_bytes())) {
        headers.insert(n, v);
      }
    }
  }
  let response = match hub.send(method, &path_and_query, headers, request.into_body()).await {
    Ok(response) => response,
    Err(HubError::Removed(message)) => {
      eprintln!("[vocorum] sign-in refused: {message}");
      return json_error(StatusCode::UNAUTHORIZED, "This device was signed out of the hub. Pair it again.");
    }
    Err(error) => return json_error(StatusCode::BAD_GATEWAY, &error.message()),
  };
  let mut out = Response::builder().status(response.status().as_u16());
  for name in RETURN {
    if let Some(value) = response.headers().get(name) {
      out = out.header(name, value.as_bytes());
    }
  }
  if response.content_length().unwrap_or(0) as usize > BODY_LIMIT {
    return json_error(StatusCode::PAYLOAD_TOO_LARGE, "This file is too large to show here.");
  }
  match response.bytes().await {
    Ok(bytes) => out.body(Cow::Owned(bytes.to_vec())).unwrap(),
    Err(_) => json_error(StatusCode::BAD_GATEWAY, "The hub closed the connection."),
  }
}

#[cfg(test)]
mod tests {
  use super::capped_range;

  #[test]
  fn open_ranges_are_capped() {
    assert_eq!(capped_range("bytes=0-").as_deref(), Some("bytes=0-4194303"));
    assert_eq!(capped_range("bytes=100-").as_deref(), Some("bytes=100-4194403"));
    assert_eq!(capped_range("bytes=0-99"), None);
    assert_eq!(capped_range("bytes=0-,5-"), None);
    assert_eq!(capped_range("items=0-"), None);
  }
}
