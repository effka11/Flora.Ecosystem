use std::ffi::{CStr, c_char};

use base64::Engine as _;
use fscp_crypto::open_notification_preview;
use uuid::Uuid;
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

pub const FSCP_PREVIEW_OK: i32 = 0;
pub const FSCP_PREVIEW_INVALID_ARGUMENT: i32 = -1;
pub const FSCP_PREVIEW_OPEN_FAILED: i32 = -2;
pub const FSCP_PREVIEW_OUTPUT_TOO_SMALL: i32 = -3;

fn open(
    wire: &str,
    recipient_user_uuid: &str,
    installation_uuid: &str,
    preview_key_id: &str,
    private_key_base64_url: &str,
) -> Result<String, i32> {
    let recipient =
        Uuid::parse_str(recipient_user_uuid).map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)?;
    let installation =
        Uuid::parse_str(installation_uuid).map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)?;
    let key_id = Uuid::parse_str(preview_key_id).map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)?;
    let mut private_key: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(private_key_base64_url)
        .map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)?
        .try_into()
        .map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)?;
    let result = open_notification_preview(
        wire,
        recipient,
        installation,
        key_id,
        &private_key,
        chrono::Utc::now(),
    )
    .map(|plaintext| plaintext.preview)
    .map_err(|_| FSCP_PREVIEW_OPEN_FAILED);
    private_key.fill(0);
    result
}

fn generate_keypair_json() -> Result<String, i32> {
    let mut private_key = [0_u8; 32];
    getrandom::fill(&mut private_key).map_err(|_| FSCP_PREVIEW_OPEN_FAILED)?;
    let public_key = x25519(private_key, X25519_BASEPOINT_BYTES);
    let variant = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let json = format!(
        r#"{{"previewKeyId":"{}","publicKeyBase64Url":"{}","privateKeyBase64Url":"{}"}}"#,
        Uuid::now_v7(),
        variant.encode(public_key),
        variant.encode(private_key),
    );
    private_key.fill(0);
    Ok(json)
}

unsafe fn write_output(value: &str, output: *mut c_char, output_len: usize) -> i32 {
    if output.is_null() || output_len == 0 {
        return FSCP_PREVIEW_INVALID_ARGUMENT;
    }
    let bytes = value.as_bytes();
    if bytes.len() + 1 > output_len {
        return FSCP_PREVIEW_OUTPUT_TOO_SMALL;
    }
    // SAFETY: caller owns a writable buffer of output_len bytes.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output.cast::<u8>(), bytes.len());
        *output.add(bytes.len()) = 0;
    }
    FSCP_PREVIEW_OK
}

/// Generates an installation preview keypair as JSON into a caller-owned buffer.
///
/// # Safety
/// `output` must reference a writable buffer of `output_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fscp_mobile_generate_preview_keypair(
    output: *mut c_char,
    output_len: usize,
) -> i32 {
    match generate_keypair_json() {
        Ok(value) => unsafe { write_output(&value, output, output_len) },
        Err(code) => code,
    }
}

unsafe fn required_cstr<'a>(value: *const c_char) -> Result<&'a str, i32> {
    if value.is_null() {
        return Err(FSCP_PREVIEW_INVALID_ARGUMENT);
    }
    // SAFETY: caller guarantees a valid NUL-terminated UTF-8 string.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map_err(|_| FSCP_PREVIEW_INVALID_ARGUMENT)
}

/// Opens a preview into a caller-owned UTF-8 buffer.
///
/// # Safety
/// All input pointers must be valid NUL-terminated UTF-8 strings. `output`
/// must reference a writable buffer of `output_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fscp_mobile_open_notification_preview(
    wire: *const c_char,
    recipient_user_uuid: *const c_char,
    installation_uuid: *const c_char,
    preview_key_id: *const c_char,
    private_key_base64_url: *const c_char,
    output: *mut c_char,
    output_len: usize,
) -> i32 {
    if output.is_null() || output_len == 0 {
        return FSCP_PREVIEW_INVALID_ARGUMENT;
    }
    let args = (
        unsafe { required_cstr(wire) },
        unsafe { required_cstr(recipient_user_uuid) },
        unsafe { required_cstr(installation_uuid) },
        unsafe { required_cstr(preview_key_id) },
        unsafe { required_cstr(private_key_base64_url) },
    );
    let (Ok(wire), Ok(recipient), Ok(installation), Ok(key_id), Ok(private_key)) = args else {
        return FSCP_PREVIEW_INVALID_ARGUMENT;
    };
    let Ok(preview) = open(wire, recipient, installation, key_id, private_key) else {
        return FSCP_PREVIEW_OPEN_FAILED;
    };
    unsafe { write_output(&preview, output, output_len) }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::JNIEnv;
    use jni::objects::{JClass, JString};
    use jni::sys::jstring;

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florasecurepush_FscpPreviewNative_openPreview(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        wire: JString<'_>,
        recipient_user_uuid: JString<'_>,
        installation_uuid: JString<'_>,
        preview_key_id: JString<'_>,
        private_key_base64_url: JString<'_>,
    ) -> jstring {
        let result = (|| {
            let wire = env.get_string(&wire).ok()?;
            let recipient = env.get_string(&recipient_user_uuid).ok()?;
            let installation = env.get_string(&installation_uuid).ok()?;
            let key_id = env.get_string(&preview_key_id).ok()?;
            let private_key = env.get_string(&private_key_base64_url).ok()?;
            open(
                wire.to_str().ok()?,
                recipient.to_str().ok()?,
                installation.to_str().ok()?,
                key_id.to_str().ok()?,
                private_key.to_str().ok()?,
            )
            .ok()
        })();
        result
            .and_then(|preview| env.new_string(preview).ok())
            .map_or(std::ptr::null_mut(), JString::into_raw)
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florasecurepush_FscpPreviewNative_generateKeypair(
        env: JNIEnv<'_>,
        _class: JClass<'_>,
    ) -> jstring {
        generate_keypair_json()
            .ok()
            .and_then(|value| env.new_string(value).ok())
            .map_or(std::ptr::null_mut(), JString::into_raw)
    }
}
