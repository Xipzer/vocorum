// The approval key: a second key, made at pairing, that the OS only uses after
// asking the person (Touch ID or Face ID in the Secure Enclave, Windows Hello on
// Windows). The hub accepts request approvals only with it. Linux has no such
// check, so Linux apps pair without one and approve with a passkey in a browser.

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
  use security_framework::access_control::{ProtectionMode, SecAccessControl};
  use security_framework::item::{ItemClass, ItemSearchOptions, Location, Reference, SearchResult};
  use security_framework::key::{Algorithm, GenerateKeyOptions, KeyType, SecKey, Token};
  use security_framework_sys::access_control::{kSecAccessControlPrivateKeyUsage, kSecAccessControlUserPresence};

  fn label(tag: &str) -> String {
    format!("dev.xipz.vocorum.approval.{tag}")
  }

  // An uncompressed P-256 point (65 bytes) for the hub.
  pub fn create(tag: &str) -> Result<Vec<u8>, String> {
    let access = SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleWhenPasscodeSetThisDeviceOnly), kSecAccessControlPrivateKeyUsage | kSecAccessControlUserPresence)
      .map_err(|e| e.to_string())?;
    let mut options = GenerateKeyOptions::default();
    options
      .set_key_type(KeyType::ec_sec_prime_random())
      .set_size_in_bits(256)
      .set_token(Token::SecureEnclave)
      .set_label(label(tag))
      .set_location(Location::DataProtectionKeychain)
      .set_access_control(access);
    let key = SecKey::new(&options).map_err(|e| e.to_string())?;
    let public = key.public_key().and_then(|k| k.external_representation()).ok_or("no public key")?;
    Ok(public.to_vec())
  }

  // An authentication context whose reason the system shows in the Touch ID or Face ID prompt.
  fn context(reason: &str) -> core_foundation::base::CFType {
    use core_foundation::base::TCFType;
    let context = unsafe { objc2_local_authentication::LAContext::new() };
    unsafe { context.setLocalizedReason(&objc2_foundation::NSString::from_str(reason)) };
    let raw = objc2::rc::Retained::into_raw(context) as core_foundation::base::CFTypeRef;
    unsafe { core_foundation::base::CFType::wrap_under_create_rule(raw) }
  }

  fn find(tag: &str) -> Result<SecKey, String> {
    let mut search = ItemSearchOptions::new();
    search.class(ItemClass::key()).label(&label(tag)).load_refs(true).local_authentication_context(Some(context("approve an agent's request")));
    #[cfg(target_os = "macos")]
    search.ignore_legacy_keychains();
    let results = search.search().map_err(|e| e.to_string())?;
    results
      .into_iter()
      .find_map(|r| match r {
        SearchResult::Ref(Reference::Key(key)) => Some(key),
        _ => None,
      })
      .ok_or_else(|| "This device's approval key is missing. Approve in a browser, or pair the app again.".to_string())
  }

  // ECDSA P-256 with SHA-256, DER encoded. The system asks for Touch ID, Face ID or the password.
  pub fn sign(tag: &str, message: &[u8]) -> Result<Vec<u8>, String> {
    find(tag)?.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message).map_err(|e| format!("Not confirmed: {e}"))
  }

  pub fn delete(tag: &str) {
    if let Ok(key) = find(tag) {
      let _ = key.delete();
    }
  }
}

#[cfg(windows)]
mod imp {
  use windows::core::HSTRING;
  use windows::Security::Credentials::{KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus};
  use windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType;
  use windows::Security::Cryptography::CryptographicBuffer;
  use windows::Storage::Streams::IBuffer;

  fn name(tag: &str) -> HSTRING {
    HSTRING::from(format!("Vocorum approval {tag}"))
  }

  fn bytes(buffer: &IBuffer) -> Result<Vec<u8>, String> {
    let mut out = windows::core::Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(buffer, &mut out).map_err(|e| e.to_string())?;
    Ok(out.to_vec())
  }

  // An RSA SubjectPublicKeyInfo: Windows Hello keys are RSA 2048.
  pub fn create(tag: &str) -> Result<Vec<u8>, String> {
    if !KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false) {
      return Err("Windows Hello isn't set up on this PC. Set it up in Windows Settings, or approve in a browser.".into());
    }
    let result = KeyCredentialManager::RequestCreateAsync(&name(tag), KeyCredentialCreationOption::ReplaceExisting)
      .and_then(|op| op.join())
      .map_err(|e| e.to_string())?;
    if result.Status().map_err(|e| e.to_string())? != KeyCredentialStatus::Success {
      return Err("Windows Hello did not make the key".into());
    }
    let credential = result.Credential().map_err(|e| e.to_string())?;
    bytes(&credential.RetrievePublicKeyWithBlobType(CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo).map_err(|e| e.to_string())?)
  }

  // RSA PKCS#1 v1.5 with SHA-256. Windows Hello asks for the PIN, face or finger.
  pub fn sign(tag: &str, message: &[u8]) -> Result<Vec<u8>, String> {
    let opened = KeyCredentialManager::OpenAsync(&name(tag)).and_then(|op| op.join()).map_err(|e| e.to_string())?;
    if opened.Status().map_err(|e| e.to_string())? != KeyCredentialStatus::Success {
      return Err("This device's approval key is missing. Approve in a browser, or pair the app again.".into());
    }
    let data = CryptographicBuffer::CreateFromByteArray(message).map_err(|e| e.to_string())?;
    let signed = opened.Credential().and_then(|c| c.RequestSignAsync(&data)).and_then(|op| op.join()).map_err(|e| e.to_string())?;
    if signed.Status().map_err(|e| e.to_string())? != KeyCredentialStatus::Success {
      return Err("Not confirmed with Windows Hello.".into());
    }
    bytes(&signed.Result().map_err(|e| e.to_string())?)
  }

  pub fn delete(tag: &str) {
    let _ = KeyCredentialManager::DeleteAsync(&name(tag)).and_then(|op| op.join());
  }
}

#[cfg(not(any(target_os = "macos", target_os = "ios", windows)))]
mod imp {
  pub fn create(_: &str) -> Result<Vec<u8>, String> {
    Err("no approval key on this system".into())
  }
  pub fn sign(_: &str, _: &[u8]) -> Result<Vec<u8>, String> {
    Err("This device can't approve requests. Approve with a passkey in a browser instead.".into())
  }
  pub fn delete(_: &str) {}
}

pub use imp::{create, delete, sign};
