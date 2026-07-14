//! TOTP — паритет `TotpCodes.cs` (Otp.NET): шаг 30 с, окно ±1, Base32 secret.

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

const STEP_SECS: u64 = 30;
const DIGITS: u32 = 6;

pub fn verify_totp(base32_secret: Option<&str>, code: &str) -> bool {
    let Some(secret) = base32_secret.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let code = code.trim();
    if code.is_empty() {
        return false;
    }

    let Ok(key) = decode_base32(secret) else {
        return false;
    };
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let counter = now / STEP_SECS;
    for skew in [0i64, -1, 1] {
        let c = counter as i64 + skew;
        if c < 0 {
            continue;
        }
        if totp_code(&key, c as u64) == code {
            return true;
        }
    }
    false
}

fn decode_base32(secret: &str) -> Result<Vec<u8>, ()> {
    let normalized: String = secret
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    // OtpNet принимает padded и unpadded.
    let padded = match normalized.len() % 8 {
        0 => normalized.clone(),
        r => format!("{normalized}{}", "=".repeat(8 - r)),
    };
    data_encoding::BASE32
        .decode(padded.as_bytes())
        .or_else(|_| BASE32_NOPAD.decode(normalized.as_bytes()))
        .map_err(|_| ())
}

fn totp_code(key: &[u8], counter: u64) -> String {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC key");
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = (hash[19] & 0x0f) as usize;
    let bin = ((u32::from(hash[offset]) & 0x7f) << 24)
        | (u32::from(hash[offset + 1]) << 16)
        | (u32::from(hash[offset + 2]) << 8)
        | u32::from(hash[offset + 3]);
    let otp = bin % 10u32.pow(DIGITS);
    format!("{otp:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_sha1_six_digits_from_known_counter() {
        // RFC 6238 Appendix B seed; 8-digit code at T=59 (counter=1) is 94287082 → 6 digits 287082.
        let key = b"12345678901234567890";
        assert_eq!(totp_code(key, 1), "287082");
    }
}
