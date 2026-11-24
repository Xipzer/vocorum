// The app's connection to one hub. Every request goes out from here, never from
// the page: TLS trusts only the hub's own CA (pinned by its SHA-256 at pairing),
// the hub's name resolves to the address from the pairing link, and requests
// carry a short-lived bearer token instead of cookies. The token comes from
// signing the hub's challenge with this device's Ed25519 key, which stays in the
// OS keychain and never leaves the device.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::secrets;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const STD64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubConfig {
  pub name: String,
  pub address: String,
  pub port: u16,
  pub ca_der: String,
  pub ca_sha256: String,
  pub key_id: String,
  pub device_id: String,
  pub device_name: String,
  #[serde(default)]
  pub signed_out: bool,
  // The approval key's name in the Secure Enclave or Windows Hello, when this device has one.
  #[serde(default)]
  pub approval_tag: Option<String>,
}

impl HubConfig {
  pub fn origin(&self) -> String {
    if self.port == 443 {
      format!("https://{}", self.name)
    } else {
      format!("https://{}:{}", self.name, self.port)
    }
  }

  pub fn socket(&self) -> Result<SocketAddr, String> {
    let ip: IpAddr = self.address.parse().map_err(|_| "Bad hub address".to_string())?;
    Ok(SocketAddr::new(ip, self.port))
  }

  fn file(dir: &Path) -> PathBuf {
    dir.join("hub.json")
  }

  pub fn load(dir: &Path) -> Option<HubConfig> {
    serde_json::from_slice(&std::fs::read(Self::file(dir)).ok()?).ok()
  }

  pub fn save(&self, dir: &Path) -> Result<(), String> {
    secrets::write_private(&Self::file(dir), &serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
  }

  pub fn remove(dir: &Path) {
    let _ = std::fs::remove_file(Self::file(dir));
  }
}

pub fn tls_config(ca_der: &[u8]) -> Result<rustls::ClientConfig, String> {
  let mut roots = rustls::RootCertStore::empty();
  roots.add(rustls::pki_types::CertificateDer::from(ca_der.to_vec())).map_err(|e| format!("Bad hub CA: {e}"))?;
  let provider = Arc::new(rustls::crypto::ring::default_provider());
  let mut config = rustls::ClientConfig::builder_with_provider(provider)
    .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
    .map_err(|e| e.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
  config.alpn_protocols = vec![b"http/1.1".to_vec()];
  Ok(config)
}

pub struct Hub {
  pub config: HubConfig,
  pub tls: Arc<rustls::ClientConfig>,
  pub http: reqwest::Client,
  dir: PathBuf,
  token: Mutex<Option<String>>,
}

#[derive(Debug)]
pub enum HubError {
  Unreachable(String),
  Removed(String),
  Other(String),
}

impl HubError {
  pub fn message(&self) -> String {
    match self {
      HubError::Unreachable(m) | HubError::Removed(m) | HubError::Other(m) => m.clone(),
    }
  }
}

fn unreachable(error: reqwest::Error) -> HubError {
  let mut text = error.to_string();
  let mut source = std::error::Error::source(&error);
  while let Some(s) = source {
    text = format!("{text}: {s}");
    source = s.source();
  }
  eprintln!("[vocorum] hub request failed: {text}");
  if text.contains("certificate") || text.contains("UnknownIssuer") || text.contains("NotValidForName") {
    return HubError::Other("The hub's certificate does not match the one this app was paired with.".into());
  }
  HubError::Unreachable("Can't reach the hub. Check the connection and try again.".into())
}

impl Hub {
  pub fn new(config: HubConfig, dir: &Path) -> Result<Hub, String> {
    let ca = STD64.decode(&config.ca_der).map_err(|_| "Bad saved CA".to_string())?;
    let tls = Arc::new(tls_config(&ca)?);
    let http = reqwest::Client::builder()
      .tls_backend_preconfigured((*tls).clone())
      .resolve(&config.name, config.socket()?)
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .no_proxy()
      .connect_timeout(Duration::from_secs(8))
      .pool_idle_timeout(Duration::from_secs(60))
      .pool_max_idle_per_host(4)
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Hub { config, tls, http, dir: dir.to_path_buf(), token: Mutex::new(None) })
  }

  pub fn url(&self, path_and_query: &str) -> String {
    format!("{}{}", self.config.origin(), path_and_query)
  }

  fn signing_key(&self) -> Result<SigningKey, HubError> {
    let secret = secrets::get(&self.dir, &self.config.key_id).map_err(HubError::Other)?;
    let bytes: [u8; 32] = secret.as_slice().try_into().map_err(|_| HubError::Other("The saved device key is damaged.".into()))?;
    Ok(SigningKey::from_bytes(&bytes))
  }

  // A valid token, signing in first when there is none.
  pub async fn token(&self) -> Result<String, HubError> {
    let mut guard = self.token.lock().await;
    if let Some(token) = guard.as_ref() {
      return Ok(token.clone());
    }
    let token = self.sign_in().await?;
    *guard = Some(token.clone());
    Ok(token)
  }

  // Drops `stale` so the next token() signs in again; another caller may already have.
  pub async fn invalidate(&self, stale: &str) {
    let mut guard = self.token.lock().await;
    if guard.as_deref() == Some(stale) {
      *guard = None;
    }
  }

  // A request approval, signed with the approval key after the OS asks the person.
  pub async fn approve(&self, request_id: &str) -> Result<serde_json::Value, HubError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Options {
      challenge_id: String,
      challenge: String,
    }
    let Some(tag) = self.config.approval_tag.clone() else {
      return Err(HubError::Other("This device cannot approve requests. Approve with a passkey in a browser instead.".into()));
    };
    if request_id.is_empty() || !request_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
      return Err(HubError::Other("Bad request id".into()));
    }
    let json = |v: serde_json::Value| {
      let mut headers = reqwest::header::HeaderMap::new();
      headers.insert(reqwest::header::CONTENT_TYPE, reqwest::header::HeaderValue::from_static("application/json"));
      (headers, v.to_string().into_bytes())
    };
    let read = |response: reqwest::Response| async move {
      let status = response.status();
      let body: serde_json::Value = response.json().await.map_err(unreachable)?;
      if status.is_success() {
        Ok(body)
      } else {
        Err(HubError::Other(body.get("error").and_then(|e| e.as_str()).unwrap_or("The hub refused the approval").to_string()))
      }
    };
    let (headers, body) = json(serde_json::json!({}));
    let options: Options = serde_json::from_value(read(self.send(reqwest::Method::POST, &format!("/client/requests/{request_id}/approve/options"), headers, body).await?).await?)
      .map_err(|e| HubError::Other(e.to_string()))?;
    let message = format!("vocorum-app-approve\n{}\n{}\n{}", options.challenge, request_id, self.config.key_id);
    let signature = tokio::task::spawn_blocking(move || crate::approval::sign(&tag, message.as_bytes()))
      .await
      .map_err(|e| HubError::Other(e.to_string()))?
      .map_err(HubError::Other)?;
    let (headers, body) = json(serde_json::json!({ "challengeId": options.challenge_id, "keyId": self.config.key_id, "signature": B64.encode(signature) }));
    read(self.send(reqwest::Method::POST, &format!("/client/requests/{request_id}/approve"), headers, body).await?).await
  }

  pub async fn forget_token(&self) -> Option<String> {
    self.token.lock().await.take()
  }

  async fn sign_in(&self) -> Result<String, HubError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Challenge {
      challenge_id: String,
      challenge: String,
    }
    #[derive(Deserialize)]
    struct Session {
      token: String,
    }
    let key = self.signing_key()?;
    let challenge: Challenge = self.post_json("/client/auth/app/challenge", &serde_json::json!({})).await?;
    let message = format!("vocorum-app-login\n{}\n{}", challenge.challenge, self.config.key_id);
    let signature = B64.encode(key.sign(message.as_bytes()).to_bytes());
    let session: Session = self
      .post_json("/client/auth/app/login", &serde_json::json!({ "challengeId": challenge.challenge_id, "keyId": self.config.key_id, "signature": signature }))
      .await?;
    Ok(session.token)
  }

  async fn post_json<T: serde::de::DeserializeOwned>(&self, path: &str, body: &serde_json::Value) -> Result<T, HubError> {
    let response = self.http.post(self.url(path)).json(body).send().await.map_err(unreachable)?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(unreachable)?;
    if status.is_success() {
      return serde_json::from_slice(&bytes).map_err(|e| HubError::Other(format!("Unexpected answer from the hub: {e}")));
    }
    let message = serde_json::from_slice::<serde_json::Value>(&bytes)
      .ok()
      .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
      .unwrap_or_else(|| format!("The hub answered {status}"));
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
      return Err(HubError::Removed(message));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
      return Err(HubError::Other("This hub does not support the app yet. Update Vocorum on the hub.".into()));
    }
    Err(HubError::Other(message))
  }

  // One request with the bearer token; on 401 sign in once more and retry.
  pub async fn send(&self, method: reqwest::Method, path_and_query: &str, headers: reqwest::header::HeaderMap, body: Vec<u8>) -> Result<reqwest::Response, HubError> {
    let mut retried = false;
    loop {
      let token = self.token().await?;
      let response = self
        .http
        .request(method.clone(), self.url(path_and_query))
        .headers(headers.clone())
        .bearer_auth(&token)
        .body(body.clone())
        .send()
        .await
        .map_err(unreachable)?;
      if response.status() == reqwest::StatusCode::UNAUTHORIZED && !retried {
        self.invalidate(&token).await;
        retried = true;
        continue;
      }
      return Ok(response);
    }
  }
}

// --- Pairing

pub struct PairLink {
  pub name: String,
  pub address: String,
  pub port: u16,
  pub http_port: u16,
  pub fingerprint: String,
  pub code: String,
}

pub fn parse_link(text: &str) -> Result<PairLink, String> {
  let bad = || "That is not a Vocorum pairing link. Run `vocorum devices add <name>` on the hub and paste the vocorum://pair link it prints.".to_string();
  let url = url::Url::parse(text.trim()).map_err(|_| bad())?;
  if url.scheme() != "vocorum" || url.host_str() != Some("pair") {
    return Err(bad());
  }
  let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
  let name = get("h").ok_or_else(bad)?.to_ascii_lowercase();
  if name.is_empty() || name.len() > 253 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
    return Err(bad());
  }
  let address = get("a").ok_or_else(bad)?;
  address.parse::<IpAddr>().map_err(|_| bad())?;
  let port = get("p").and_then(|p| p.parse::<u16>().ok()).ok_or_else(bad)?;
  let http_port = get("hp").and_then(|p| p.parse::<u16>().ok()).ok_or_else(bad)?;
  let fingerprint = get("fp").ok_or_else(bad)?.replace(':', "").to_ascii_lowercase();
  if fingerprint.len() != 64 || !fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
    return Err(bad());
  }
  let code = get("c").ok_or_else(bad)?.trim().to_ascii_uppercase();
  if code.is_empty() || code.len() > 64 {
    return Err(bad());
  }
  Ok(PairLink { name, address, port, http_port, fingerprint, code })
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// Fetches the CA from the hub's plain enrolment port and keeps it only if its
// SHA-256 matches the link, so the plain transport cannot swap it.
async fn fetch_ca(link: &PairLink) -> Result<Vec<u8>, String> {
  let client = reqwest::Client::builder()
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(8))
    .timeout(Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;
  let host = if link.address.contains(':') { format!("[{}]", link.address) } else { link.address.clone() };
  let response = client
    .get(format!("http://{host}:{}/vocorum-ca.crt", link.http_port))
    .send()
    .await
    .map_err(|_| "Can't reach the hub's enrolment page. Check the address and that this device is on the hub's network.".to_string())?;
  if !response.status().is_success() {
    return Err(format!("The hub's enrolment page answered {}", response.status()));
  }
  let der = response.bytes().await.map_err(|e| e.to_string())?;
  if der.len() > 16 * 1024 {
    return Err("The hub's CA is too large".into());
  }
  if hex(&Sha256::digest(&der)) != link.fingerprint {
    return Err("The hub's certificate does not match the pairing link. Do not continue: someone may be in the middle.".into());
  }
  Ok(der.to_vec())
}

pub async fn pair(dir: &Path, link: &PairLink) -> Result<HubConfig, String> {
  #[derive(Deserialize)]
  struct Device {
    id: String,
    name: String,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Registered {
    device: Device,
    key_id: String,
  }
  let ca = fetch_ca(link).await?;
  let mut seed = [0u8; 32];
  getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
  let key = SigningKey::from_bytes(&seed);
  let draft = HubConfig {
    name: link.name.clone(),
    address: link.address.clone(),
    port: link.port,
    ca_der: STD64.encode(&ca),
    ca_sha256: link.fingerprint.clone(),
    key_id: String::new(),
    device_id: String::new(),
    device_name: String::new(),
    signed_out: false,
    approval_tag: None,
  };
  let hub = Hub::new(draft.clone(), dir)?;
  // Only at pairing: the hub never lets a signed in app add an approval key later.
  let tag = hex(&seed[..8]);
  let approval = {
    let tag = tag.clone();
    tokio::task::spawn_blocking(move || crate::approval::create(&tag)).await.map_err(|e| e.to_string())?
  };
  let approval = match approval {
    Ok(public) => Some(public),
    Err(error) => {
      eprintln!("[vocorum] pairing without an approval key: {error}");
      None
    }
  };
  let registered = hub
    .post_json::<Registered>(
      "/client/auth/app/register",
      &serde_json::json!({ "code": link.code, "publicKey": B64.encode(key.verifying_key().to_bytes()), "approvalKey": approval.as_ref().map(|k| B64.encode(k)) }),
    )
    .await
    .map_err(|e| e.message());
  let registered = match registered {
    Ok(r) => r,
    Err(error) => {
      if approval.is_some() {
        crate::approval::delete(&tag);
      }
      return Err(error);
    }
  };
  if registered.key_id.is_empty() || registered.key_id.len() > 128 || !registered.key_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
    return Err("The hub sent back a bad key id".into());
  }
  secrets::put(dir, &registered.key_id, &seed)?;
  let config = HubConfig { key_id: registered.key_id, device_id: registered.device.id, device_name: registered.device.name, approval_tag: approval.map(|_| tag), ..draft };
  config.save(dir)?;
  Ok(config)
}
