//! ffmpeg/ffprobe: AAC-LC 256k при выгоде; иначе оригинал MP3/M4A.
//! Паритет с `FfmpegMusicAudioTranscoder.cs`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, warn};
use uuid::Uuid;

const TARGET_MUSIC_BITRATE_BPS: i32 = 256_000;
const OUTPUT_CONTENT_TYPE: &str = "audio/mp4";
const DEFAULT_PROCESS_TIMEOUT_SECS: u64 = 60;
const TRANSCODE_TIMEOUT_SECS: u64 = 240;
const STDERR_TAIL_MAX: usize = 600;

const STORABLE_CODECS: &[&str] = &["mp3", "aac"];

/// Пути к ffmpeg/ffprobe (секция Media, как у Flora.Content).
#[derive(Debug, Clone)]
pub struct MusicMediaOptions {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
}

impl Default for MusicMediaOptions {
    fn default() -> Self {
        Self {
            ffmpeg_path: "ffmpeg".into(),
            ffprobe_path: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedAudio {
    pub data: Vec<u8>,
    pub content_type: String,
    pub duration_ms: i32,
    pub file_size_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscodeError {
    /// 503: ffmpeg с AAC недоступен.
    Unavailable,
    /// 400: валидация / сбой обработки (русские сообщения как в C#).
    BadRequest(String),
}

impl TranscodeError {
    pub fn message(&self) -> &str {
        match self {
            Self::Unavailable => {
                "Обработка аудио временно недоступна (на сервере не настроен ffmpeg с AAC)."
            }
            Self::BadRequest(msg) => msg.as_str(),
        }
    }
}

impl std::fmt::Display for TranscodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

#[derive(Debug)]
struct AudioProbeResult {
    codec_name: String,
    effective_bitrate_bps: i32,
    duration_ms: i32,
}

pub struct FfmpegMusicAudioTranscoder {
    options: MusicMediaOptions,
    available: Mutex<Option<bool>>,
}

impl FfmpegMusicAudioTranscoder {
    pub fn new(options: MusicMediaOptions) -> Self {
        Self {
            options,
            available: Mutex::new(None),
        }
    }

    fn ffmpeg_path(&self) -> String {
        let p = self.options.ffmpeg_path.trim();
        if p.is_empty() {
            "ffmpeg".into()
        } else {
            p.to_string()
        }
    }

    fn ffprobe_path(&self) -> String {
        let opt = self.options.ffprobe_path.trim();
        if !opt.is_empty() {
            return opt.to_string();
        }
        let ffmpeg = self.ffmpeg_path();
        let path = Path::new(&ffmpeg);
        match path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => {
                let ext = path
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                dir.join(format!("ffprobe{ext}"))
                    .to_string_lossy()
                    .into_owned()
            }
            _ => "ffprobe".into(),
        }
    }

    pub async fn is_available(&self) -> bool {
        {
            let guard = self.available.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(v) = *guard {
                return v;
            }
        }

        let result = match run_async(
            &self.ffmpeg_path(),
            &["-hide_banner", "-encoders"],
            DEFAULT_PROCESS_TIMEOUT_SECS,
        )
        .await
        {
            Ok((code, stdout, _)) => {
                let ok = code == 0 && contains_aac_encoder(&stdout);
                if !ok {
                    warn!("ffmpeg найден, но без энкодера aac — транскод музыки недоступен.");
                }
                ok
            }
            Err(e) => {
                warn!(
                    error = %e,
                    path = %self.ffmpeg_path(),
                    "ffmpeg недоступен"
                );
                false
            }
        };

        let mut guard = self.available.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(result);
        result
    }

    pub async fn prepare(
        &self,
        bytes: &[u8],
        content_type: &str,
        file_name: &str,
    ) -> Result<PreparedAudio, TranscodeError> {
        if bytes.is_empty() {
            return Err(TranscodeError::BadRequest("Файл пуст.".into()));
        }

        let ext = guess_extension(file_name, content_type);
        let input_path = temp_path(&format!("flora-music-in-{}{ext}", Uuid::now_v7().simple()));

        tokio::fs::write(&input_path, bytes)
            .await
            .map_err(|e| TranscodeError::BadRequest(format!("Не удалось прочитать аудио: {e}")))?;

        let result = self
            .prepare_with_input(&input_path, bytes, content_type, file_name)
            .await;
        try_delete(&input_path).await;
        result
    }

    async fn prepare_with_input(
        &self,
        input_path: &Path,
        input_bytes: &[u8],
        content_type_hint: &str,
        file_name_hint: &str,
    ) -> Result<PreparedAudio, TranscodeError> {
        let probe = self
            .probe_audio(input_path, input_bytes.len() as i64)
            .await?;
        let original_content_type =
            resolve_original_content_type(content_type_hint, file_name_hint, &probe.codec_name);

        if is_fast_path_keep_original(&probe) {
            return Ok(prepared(
                input_bytes.to_vec(),
                original_content_type,
                probe.duration_ms,
            ));
        }

        if !self.is_available().await {
            return Err(TranscodeError::Unavailable);
        }

        let transcoded = self.transcode_to_aac_lc(input_path).await?;
        if !is_storable_codec(&probe.codec_name) || transcoded.len() < input_bytes.len() {
            let duration_ms = if probe.duration_ms > 0 {
                probe.duration_ms
            } else {
                self.probe_duration_only(&transcoded).await?
            };
            return Ok(prepared(
                transcoded,
                OUTPUT_CONTENT_TYPE.into(),
                duration_ms,
            ));
        }

        debug!(
            original = input_bytes.len(),
            transcoded = transcoded.len(),
            "Музыка: оригинал меньше транскода, сохраняем исходник."
        );

        Ok(prepared(
            input_bytes.to_vec(),
            original_content_type,
            probe.duration_ms,
        ))
    }

    async fn transcode_to_aac_lc(&self, input_path: &Path) -> Result<Vec<u8>, TranscodeError> {
        let out_path = temp_path(&format!("flora-music-out-{}.m4a", Uuid::now_v7().simple()));
        let input_str = input_path.to_string_lossy();
        let out_str = out_path.to_string_lossy();

        let args = [
            "-y",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            input_str.as_ref(),
            "-vn",
            "-map_metadata",
            "-1",
            "-threads",
            "2",
            "-c:a",
            "aac",
            "-profile:a",
            "aac_low",
            "-b:a",
            "256k",
            "-ar",
            "44100",
            "-movflags",
            "+faststart",
            out_str.as_ref(),
        ];

        let run = run_async(&self.ffmpeg_path(), &args, TRANSCODE_TIMEOUT_SECS).await;
        let result = match run {
            Ok((0, _, _)) => tokio::fs::read(&out_path).await.map_err(|e| {
                TranscodeError::BadRequest(format!("Не удалось обработать аудио: {e}"))
            }),
            Ok((_, _, stderr)) => Err(TranscodeError::BadRequest(format!(
                "Не удалось обработать аудио: {}",
                tail(&stderr)
            ))),
            Err(TranscodeError::BadRequest(msg))
                if msg == "Обработка аудио превысила лимит времени." =>
            {
                Err(TranscodeError::BadRequest(msg))
            }
            Err(e) => Err(TranscodeError::BadRequest(format!(
                "Не удалось обработать аудио: {}",
                e.message()
            ))),
        };
        try_delete(&out_path).await;
        result
    }

    async fn probe_audio(
        &self,
        input_path: &Path,
        file_bytes: i64,
    ) -> Result<AudioProbeResult, TranscodeError> {
        let input_str = input_path.to_string_lossy();
        let args = [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,bit_rate",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            input_str.as_ref(),
        ];

        let (code, stdout, stderr) =
            match run_async(&self.ffprobe_path(), &args, DEFAULT_PROCESS_TIMEOUT_SECS).await {
                Ok(v) => v,
                Err(TranscodeError::BadRequest(msg))
                    if msg == "Обработка аудио превысила лимит времени." =>
                {
                    return Err(TranscodeError::BadRequest(msg));
                }
                Err(e) => {
                    return Err(TranscodeError::BadRequest(format!(
                        "Не удалось прочитать аудио: {}",
                        e.message()
                    )));
                }
            };

        if code != 0 {
            return Err(TranscodeError::BadRequest(format!(
                "Не удалось прочитать аудио: {}",
                tail(&stderr)
            )));
        }

        parse_probe_json(&stdout, file_bytes)
    }

    async fn probe_duration_only(&self, m4a_bytes: &[u8]) -> Result<i32, TranscodeError> {
        let path = temp_path(&format!(
            "flora-music-probe-{}.m4a",
            Uuid::now_v7().simple()
        ));
        tokio::fs::write(&path, m4a_bytes)
            .await
            .map_err(|e| TranscodeError::BadRequest(format!("Не удалось прочитать аудио: {e}")))?;
        let result = self
            .probe_audio(&path, m4a_bytes.len() as i64)
            .await
            .map(|p| p.duration_ms);
        try_delete(&path).await;
        result
    }
}

fn prepared(data: Vec<u8>, content_type: String, duration_ms: i32) -> PreparedAudio {
    let file_size_bytes = data.len() as i64;
    PreparedAudio {
        data,
        content_type,
        duration_ms,
        file_size_bytes,
    }
}

fn contains_aac_encoder(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains(" aac ")
}

fn is_storable_codec(codec_name: &str) -> bool {
    let trimmed = codec_name.trim();
    STORABLE_CODECS
        .iter()
        .any(|c| c.eq_ignore_ascii_case(trimmed))
}

fn is_fast_path_keep_original(probe: &AudioProbeResult) -> bool {
    is_storable_codec(&probe.codec_name) && probe.effective_bitrate_bps <= TARGET_MUSIC_BITRATE_BPS
}

fn normalize_content_type(content_type: &str) -> String {
    let trimmed = content_type.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.split(';').next().unwrap_or("").trim().to_string()
}

fn resolve_original_content_type(
    content_type_hint: &str,
    file_name_hint: &str,
    codec_name: &str,
) -> String {
    let normalized = normalize_content_type(content_type_hint);
    if !normalized.is_empty() {
        return normalized;
    }
    let name = file_name_hint.trim();
    if !name.is_empty() && name.to_ascii_lowercase().ends_with(".mp3") {
        return "audio/mpeg".into();
    }
    if !name.is_empty() {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".m4a") || lower.ends_with(".mp4") {
            return "audio/mp4".into();
        }
    }
    if codec_name.eq_ignore_ascii_case("aac") {
        "audio/mp4".into()
    } else {
        "audio/mpeg".into()
    }
}

fn guess_extension(file_name_hint: &str, content_type_hint: &str) -> String {
    let name = file_name_hint.trim();
    if !name.is_empty() {
        let ext = Path::new(name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        if !ext.is_empty() && ext != "." {
            return ext;
        }
    }

    match normalize_content_type(content_type_hint).as_str() {
        "audio/mpeg" | "audio/mp3" => ".mp3".into(),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => ".m4a".into(),
        "audio/flac" => ".flac".into(),
        "audio/wav" | "audio/x-wav" => ".wav".into(),
        "audio/ogg" => ".ogg".into(),
        "audio/webm" => ".webm".into(),
        _ => ".bin".into(),
    }
}

fn parse_probe_json(stdout: &str, file_bytes: i64) -> Result<AudioProbeResult, TranscodeError> {
    let root: serde_json::Value = serde_json::from_str(stdout).map_err(|_| {
        TranscodeError::BadRequest("Не удалось прочитать аудио: invalid json".into())
    })?;

    let streams = root
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| TranscodeError::BadRequest("В файле нет аудиодорожки.".into()))?;

    if streams.is_empty() {
        return Err(TranscodeError::BadRequest(
            "В файле нет аудиодорожки.".into(),
        ));
    }

    let stream = &streams[0];
    let codec_name = json_string(stream.get("codec_name")).unwrap_or_default();

    let mut bit_rate = 0_i32;
    if let Some(br) = json_string(stream.get("bit_rate"))
        && let Ok(parsed) = br.parse::<i32>()
    {
        bit_rate = parsed;
    }

    let mut duration_ms = 0_i32;
    if let Some(format) = root.get("format")
        && let Some(dur) = json_string(format.get("duration"))
        && let Ok(seconds) = dur.parse::<f64>()
    {
        duration_ms = (seconds * 1000.0).round() as i32;
    }

    if bit_rate <= 0 && duration_ms > 0 {
        let secs = duration_ms as f64 / 1000.0;
        bit_rate = (file_bytes as f64 * 8.0 / secs).round() as i32;
    }

    Ok(AudioProbeResult {
        codec_name,
        effective_bitrate_bps: bit_rate,
        duration_ms,
    })
}

fn json_string(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn temp_path(file_name: &str) -> PathBuf {
    std::env::temp_dir().join(file_name)
}

fn tail(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= STDERR_TAIL_MAX {
        trimmed.to_string()
    } else {
        trimmed[trimmed.len() - STDERR_TAIL_MAX..].to_string()
    }
}

async fn try_delete(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

async fn run_async(
    file_name: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(i32, String, String), TranscodeError> {
    let mut child = Command::new(file_name)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            TranscodeError::BadRequest(format!("Не удалось запустить процесс '{file_name}': {e}"))
        })?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let collect = async {
        let stdout_fut = async {
            let mut buf = Vec::new();
            if let Some(mut pipe) = stdout_pipe {
                pipe.read_to_end(&mut buf).await?;
            }
            Ok::<_, std::io::Error>(buf)
        };
        let stderr_fut = async {
            let mut buf = Vec::new();
            if let Some(mut pipe) = stderr_pipe {
                pipe.read_to_end(&mut buf).await?;
            }
            Ok::<_, std::io::Error>(buf)
        };

        let (out_res, err_res, status_res) = tokio::join!(stdout_fut, stderr_fut, child.wait());
        let stdout_buf = out_res?;
        let stderr_buf = err_res?;
        let status = status_res?;
        let code = status.code().unwrap_or(-1);
        Ok::<_, std::io::Error>((
            code,
            String::from_utf8_lossy(&stdout_buf).into_owned(),
            String::from_utf8_lossy(&stderr_buf).into_owned(),
        ))
    };

    match timeout(Duration::from_secs(timeout_secs), collect).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(e)) => Err(TranscodeError::BadRequest(format!(
            "Не удалось запустить процесс '{file_name}': {e}"
        ))),
        Err(_) => {
            // kill_on_drop on Child; also try explicit kill if still in scope — Child dropped with future
            Err(TranscodeError::BadRequest(
                "Обработка аудио превысила лимит времени.".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storable_codecs_are_mp3_and_aac() {
        assert!(is_storable_codec("mp3"));
        assert!(is_storable_codec("MP3"));
        assert!(is_storable_codec(" aac "));
        assert!(is_storable_codec("AAC"));
        assert!(!is_storable_codec("flac"));
        assert!(!is_storable_codec("opus"));
        assert!(!is_storable_codec(""));
    }

    #[test]
    fn fast_path_requires_storable_and_bitrate_at_or_below_256k() {
        assert!(is_fast_path_keep_original(&AudioProbeResult {
            codec_name: "mp3".into(),
            effective_bitrate_bps: TARGET_MUSIC_BITRATE_BPS,
            duration_ms: 1_000,
        }));
        assert!(is_fast_path_keep_original(&AudioProbeResult {
            codec_name: "aac".into(),
            effective_bitrate_bps: 128_000,
            duration_ms: 1_000,
        }));
        assert!(!is_fast_path_keep_original(&AudioProbeResult {
            codec_name: "mp3".into(),
            effective_bitrate_bps: TARGET_MUSIC_BITRATE_BPS + 1,
            duration_ms: 1_000,
        }));
        assert!(!is_fast_path_keep_original(&AudioProbeResult {
            codec_name: "flac".into(),
            effective_bitrate_bps: 128_000,
            duration_ms: 1_000,
        }));
    }

    #[test]
    fn effective_bitrate_falls_back_from_file_size() {
        // 1_000_000 bytes over 10s → 800_000 bps
        let json = r#"{
            "streams": [{"codec_name": "flac", "bit_rate": "0"}],
            "format": {"duration": "10.0"}
        }"#;
        let probe = parse_probe_json(json, 1_000_000).unwrap();
        assert_eq!(probe.effective_bitrate_bps, 800_000);
        assert_eq!(probe.duration_ms, 10_000);
        assert_eq!(probe.codec_name, "flac");
    }

    #[test]
    fn probe_rejects_missing_audio_stream() {
        let err = parse_probe_json(r#"{"streams":[]}"#, 100).unwrap_err();
        assert_eq!(
            err,
            TranscodeError::BadRequest("В файле нет аудиодорожки.".into())
        );
    }

    #[test]
    fn guess_extension_from_name_and_content_type() {
        assert_eq!(guess_extension("track.MP3", ""), ".MP3");
        assert_eq!(guess_extension("", "audio/mpeg"), ".mp3");
        assert_eq!(guess_extension("", "audio/mp4; codecs=mp4a"), ".m4a");
        assert_eq!(guess_extension("", "audio/flac"), ".flac");
        assert_eq!(guess_extension("", ""), ".bin");
    }

    #[test]
    fn resolve_content_type_prefers_hint_then_extension_then_codec() {
        assert_eq!(
            resolve_original_content_type("audio/mpeg; charset=binary", "x.m4a", "aac"),
            "audio/mpeg"
        );
        assert_eq!(
            resolve_original_content_type("", "song.mp3", "mp3"),
            "audio/mpeg"
        );
        assert_eq!(
            resolve_original_content_type("", "song.m4a", "aac"),
            "audio/mp4"
        );
        assert_eq!(resolve_original_content_type("", "", "aac"), "audio/mp4");
        assert_eq!(resolve_original_content_type("", "", "mp3"), "audio/mpeg");
    }

    #[test]
    fn unavailable_message_matches_csharp() {
        assert_eq!(
            TranscodeError::Unavailable.message(),
            "Обработка аудио временно недоступна (на сервере не настроен ffmpeg с AAC)."
        );
    }

    #[test]
    fn media_options_default() {
        let o = MusicMediaOptions::default();
        assert_eq!(o.ffmpeg_path, "ffmpeg");
        assert_eq!(o.ffprobe_path, "");
    }
}
