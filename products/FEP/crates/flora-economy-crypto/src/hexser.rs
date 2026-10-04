//! Serde-хелпер: фиксированные байтовые массивы ↔ hex-строка (lowercase).
//!
//! JSON-представление хешей/ключей/подписей/nonce — hex, а не массив чисел: читаемо в test
//! vectors и стабильно как контракт. Используется через `#[serde(with = "hexser")]`.

use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer, const N: usize>(
    bytes: &[u8; N],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut s = String::with_capacity(N * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).expect("nibble < 16"));
        s.push(char::from_digit((b & 0x0f) as u32, 16).expect("nibble < 16"));
    }
    serializer.serialize_str(&s)
}

pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
    deserializer: D,
) -> Result<[u8; N], D::Error> {
    let s = String::deserialize(deserializer)?;
    if s.len() != N * 2 {
        return Err(serde::de::Error::custom(format!(
            "ожидалось {} hex-символов, получено {}",
            N * 2,
            s.len()
        )));
    }
    let mut out = [0u8; N];
    let bytes = s.as_bytes();
    for (i, item) in out.iter_mut().enumerate() {
        let hi = hex_nibble(bytes[i * 2]).ok_or_else(bad_hex::<D>)?;
        let lo = hex_nibble(bytes[i * 2 + 1]).ok_or_else(bad_hex::<D>)?;
        *item = (hi << 4) | lo;
    }
    Ok(out)
}

fn bad_hex<'de, D: Deserializer<'de>>() -> D::Error {
    serde::de::Error::custom("некорректный hex-символ")
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Wrap {
        #[serde(with = "super")]
        sig: [u8; 64],
        #[serde(with = "super")]
        hash: [u8; 32],
    }

    #[test]
    fn roundtrip() {
        let w = Wrap {
            sig: [7u8; 64],
            hash: [0xabu8; 32],
        };
        let json = serde_json::to_string(&w).unwrap();
        assert!(json.contains(&"07".repeat(64)));
        assert!(json.contains(&"ab".repeat(32)));
        let back: Wrap = serde_json::from_str(&json).unwrap();
        assert_eq!(back, w);
    }

    #[test]
    fn wrong_length_rejected() {
        let err = serde_json::from_str::<Wrap>(&format!(
            "{{\"sig\":\"00\",\"hash\":\"{}\"}}",
            "00".repeat(32)
        ));
        assert!(err.is_err());
    }
}
