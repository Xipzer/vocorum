// The device's private key lives in the OS secure store: Keychain on macOS and
// iOS, Credential Manager on Windows, the Secret Service on Linux. Linux
// desktops without a Secret Service (WSL, bare window managers) fall back to a
// 0600 file in the app's config folder, and the app says so in its logs.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SERVICE: &str = "dev.xipz.vocorum";

static STORE: OnceLock<Result<(), String>> = OnceLock::new();

fn native_store() -> Result<(), String> {
  STORE
    .get_or_init(|| {
      #[cfg(target_os = "macos")]
      let store = apple_native_keyring_store::keychain::Store::new();
      #[cfg(target_os = "ios")]
      let store = apple_native_keyring_store::protected::Store::new();
      #[cfg(target_os = "windows")]
      let store = windows_native_keyring_store::Store::new();
      #[cfg(target_os = "linux")]
      let store = zbus_secret_service_keyring_store::Store::new();
      #[cfg(not(target_os = "android"))]
      return store.map(|s| keyring_core::set_default_store(s)).map_err(|e| e.to_string());
      #[cfg(target_os = "android")]
      Err("Android is not supported yet".to_string())
    })
    .clone()
}

fn fallback_file(dir: &Path, account: &str) -> PathBuf {
  dir.join(format!("device-key-{account}"))
}

pub fn put(dir: &Path, account: &str, secret: &[u8]) -> Result<(), String> {
  let native = native_store().and_then(|_| keyring_core::Entry::new(SERVICE, account).and_then(|e| e.set_secret(secret)).map_err(|e| e.to_string()));
  match native {
    Ok(()) => Ok(()),
    Err(error) if cfg!(target_os = "linux") => {
      eprintln!("[vocorum] no Secret Service ({error}); keeping the device key in a 0600 file");
      write_private(&fallback_file(dir, account), secret)
    }
    Err(error) => Err(format!("Couldn't save this device's key in the keychain: {error}")),
  }
}

pub fn get(dir: &Path, account: &str) -> Result<Vec<u8>, String> {
  let native = native_store().and_then(|_| keyring_core::Entry::new(SERVICE, account).and_then(|e| e.get_secret()).map_err(|e| e.to_string()));
  match native {
    Ok(secret) => Ok(secret),
    Err(error) => {
      let file = fallback_file(dir, account);
      if cfg!(target_os = "linux") && file.exists() {
        return std::fs::read(file).map_err(|e| e.to_string());
      }
      Err(format!("The device key is missing from the system keychain: {error}"))
    }
  }
}

pub fn delete(dir: &Path, account: &str) {
  if native_store().is_ok() {
    if let Ok(entry) = keyring_core::Entry::new(SERVICE, account) {
      let _ = entry.delete_credential();
    }
  }
  let _ = std::fs::remove_file(fallback_file(dir, account));
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let tmp = path.with_extension("tmp");
  {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
  }
  std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
