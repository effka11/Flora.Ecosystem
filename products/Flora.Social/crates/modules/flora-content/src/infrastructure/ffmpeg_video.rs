//! ffmpeg/ffprobe: AV1 (SVT-AV1) + Opus MP4, постер WebP, опциональный H.264.
//! Паритет с `FfmpegVideoTranscoder.cs`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use frc_i_integration::{FRC_I_MIME, IngestOptions, ingest};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;
use uuid::Uuid;

/// Длинная сторона ≤ 1920 (1080p-класс), без апскейла, размеры чётные.
const MAX_LONG_SIDE: i32 = 1920;
/// CRF 32 на preset 7 — как в C#.
const SVT_CRF: i32 = 32;
const SVT_PRESET: i32 = 7;
const POSTER_MAX_DIMENSION: u32 = 1280;
const DEFAULT_PROCESS_TIMEOUT_SECS: u64 = 90;
const TRANSCODE_TIMEOUT_SECS: u64 = 600;
const STDERR_TAIL_MAX: usize = 600;

/// Пути к ffmpeg/ffprobe (секция `Media`, как у Music / C# MediaTranscodingOptions).
#[derive(Debug, Clone)]
pub struct MediaOptions {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub frc_i_backfill_enabled: bool,
}

impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            ffmpeg_path: "ffmpeg".into(),
            ffprobe_path: String::new(),
            frc_i_backfill_enabled: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoProbeResult {
    pub width: i32,
    pub height: i32,
    pub duration_ms: i32,
}

#[derive(Debug, Clone)]
pub struct VideoTranscodeResult {
    pub video_data: Vec<u8>,
    pub video_content_type: String,
    pub poster_data: Vec<u8>,
    pub poster_content_type: String,
    pub width: i32,
    pub height: i32,
    pub duration_ms: i32,
    pub compatibility_video_data: Option<Vec<u8>>,
    pub compatibility_video_content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoTranscodeError {
    Unavailable,
    Probe(String),
    Transcode(String),
}

impl VideoTranscodeError {
    pub fn message(&self) -> &str {
        match self {
            Self::Unavailable => {
                "Обработка видео временно недоступна (на сервере не настроен ffmpeg с SVT-AV1)."
            }
            Self::Probe(msg) | Self::Transcode(msg) => msg.as_str(),
        }
    }
}

impl std::fmt::Display for VideoTranscodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

pub struct FfmpegVideoTranscoder {
    options: MediaOptions,
    available: Mutex<Option<bool>>,
}

impl FfmpegVideoTranscoder {
    pub fn new(options: MediaOptions) -> Self {
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
                let ok = code == 0 && stdout.to_ascii_lowercase().contains("libsvtav1");
                if !ok {
                    warn!(
                        "ffmpeg найден, но без энкодера libsvtav1 — загрузка видео постов недоступна."
                    );
                }
                ok
            }
            Err(e) => {
                warn!(
                    error = %e,
                    path = %self.ffmpeg_path(),
                    "ffmpeg недоступен — загрузка видео постов недоступна"
                );
                false
            }
        };

        let mut guard = self.available.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(result);
        result
    }

    pub async fn probe(&self, input_path: &Path) -> Result<VideoProbeResult, VideoTranscodeError> {
        let input_str = input_path.to_string_lossy();
        let args = [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            input_str.as_ref(),
        ];

        let (code, stdout, stderr) =
            match run_async(&self.ffprobe_path(), &args, DEFAULT_PROCESS_TIMEOUT_SECS).await {
                Ok(v) => v,
                Err(e) => {
                    return Err(VideoTranscodeError::Probe(format!(
                        "ffprobe: {}",
                        e.message()
                    )));
                }
            };

        if code != 0 {
            return Err(VideoTranscodeError::Probe(format!(
                "ffprobe завершился с кодом {code}: {}",
                tail(&stderr)
            )));
        }

        parse_probe_json(&stdout)
    }

    pub async fn transcode(
        &self,
        input_path: &Path,
    ) -> Result<VideoTranscodeResult, VideoTranscodeError> {
        let out_path = temp_path(&format!("flora-video-{}.mp4", Uuid::now_v7().simple()));
        let poster_path = temp_path(&format!("flora-poster-{}.png", Uuid::now_v7().simple()));
        let result = self
            .transcode_inner(input_path, &out_path, &poster_path)
            .await;
        try_delete(&out_path).await;
        try_delete(&poster_path).await;
        result
    }

    async fn transcode_inner(
        &self,
        input_path: &Path,
        out_path: &Path,
        poster_path: &Path,
    ) -> Result<VideoTranscodeResult, VideoTranscodeError> {
        let input_str = input_path.to_string_lossy();
        let out_str = out_path.to_string_lossy();
        let scale_factor = format!("min(1,min({MAX_LONG_SIDE}/iw,{MAX_LONG_SIDE}/ih))");
        let scale = format!("scale='trunc(iw*{scale_factor}/2)*2':'trunc(ih*{scale_factor}/2)*2'");
        let preset = SVT_PRESET.to_string();
        let crf = SVT_CRF.to_string();

        let args = [
            "-y",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            input_str.as_ref(),
            "-map_metadata",
            "-1",
            "-vf",
            scale.as_str(),
            "-c:v",
            "libsvtav1",
            "-preset",
            preset.as_str(),
            "-crf",
            crf.as_str(),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            out_str.as_ref(),
        ];

        let (code, _, stderr) = run_async(&self.ffmpeg_path(), &args, TRANSCODE_TIMEOUT_SECS)
            .await
            .map_err(|e| VideoTranscodeError::Transcode(e.message().to_string()))?;
        if code != 0 {
            return Err(VideoTranscodeError::Transcode(format!(
                "ffmpeg завершился с кодом {code}: {}",
                tail(&stderr)
            )));
        }

        let probe = self.probe(out_path).await.map_err(|e| {
            VideoTranscodeError::Transcode(format!("probe output: {}", e.message()))
        })?;

        let poster_at_sec = (0.5_f64).min(probe.duration_ms as f64 / 2000.0);
        let poster_ss = format!("{poster_at_sec:.3}");
        let poster_str = poster_path.to_string_lossy();
        let poster_args = [
            "-y",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            poster_ss.as_str(),
            "-i",
            out_str.as_ref(),
            "-frames:v",
            "1",
            poster_str.as_ref(),
        ];
        let (poster_code, _, poster_stderr) = run_async(
            &self.ffmpeg_path(),
            &poster_args,
            DEFAULT_PROCESS_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| VideoTranscodeError::Transcode(e.message().to_string()))?;
        if poster_code != 0 {
            return Err(VideoTranscodeError::Transcode(format!(
                "ffmpeg (постер) завершился с кодом {poster_code}: {}",
                tail(&poster_stderr)
            )));
        }

        let (poster_data, poster_content_type) = encode_poster_fri(poster_path).await?;
        let video_data = tokio::fs::read(out_path).await.map_err(|e| {
            VideoTranscodeError::Transcode(format!("Не удалось прочитать выход: {e}"))
        })?;

        let (compat_data, compat_ct) = self.try_h264_compat(input_path).await;

        Ok(VideoTranscodeResult {
            video_data,
            video_content_type: "video/mp4".into(),
            poster_data,
            poster_content_type,
            width: probe.width,
            height: probe.height,
            duration_ms: probe.duration_ms,
            compatibility_video_data: compat_data,
            compatibility_video_content_type: compat_ct,
        })
    }

    async fn try_h264_compat(&self, input_path: &Path) -> (Option<Vec<u8>>, Option<String>) {
        let h264_out = temp_path(&format!("flora-video-h264-{}.mp4", Uuid::now_v7().simple()));
        let input_str = input_path.to_string_lossy();
        let out_str = h264_out.to_string_lossy();
        let scale_factor = format!("min(1,min({MAX_LONG_SIDE}/iw,{MAX_LONG_SIDE}/ih))");
        let scale = format!("scale='trunc(iw*{scale_factor}/2)*2':'trunc(ih*{scale_factor}/2)*2'");
        let args = [
            "-y",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            input_str.as_ref(),
            "-map_metadata",
            "-1",
            "-vf",
            scale.as_str(),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            out_str.as_ref(),
        ];

        let result = match run_async(&self.ffmpeg_path(), &args, TRANSCODE_TIMEOUT_SECS).await {
            Ok((0, _, _)) => match tokio::fs::read(&h264_out).await {
                Ok(data) => (Some(data), Some("video/mp4".into())),
                Err(_) => (None, None),
            },
            Ok((_, _, err)) => {
                warn!("H.264 compatibility renditions skipped: {}", tail(&err));
                (None, None)
            }
            Err(e) => {
                warn!("H.264 compatibility renditions skipped: {}", e.message());
                (None, None)
            }
        };
        try_delete(&h264_out).await;
        result
    }
}

async fn encode_poster_fri(
    poster_png_path: &Path,
) -> Result<(Vec<u8>, String), VideoTranscodeError> {
    let bytes = tokio::fs::read(poster_png_path)
        .await
        .map_err(|e| VideoTranscodeError::Transcode(format!("Не удалось прочитать постер: {e}")))?;
    let encoded = ingest(
        &bytes,
        IngestOptions {
            max_dimension: POSTER_MAX_DIMENSION,
            max_pixels: 50_000_000,
            quality: 85,
        },
    )
    .map_err(|error| VideoTranscodeError::Transcode(format!("постер FRC-I: {error}")))?;
    Ok((encoded.bytes, FRC_I_MIME.into()))
}

fn parse_probe_json(stdout: &str) -> Result<VideoProbeResult, VideoTranscodeError> {
    let root: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|_| VideoTranscodeError::Probe("Не удалось разобрать вывод ffprobe.".into()))?;

    let streams = root
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| VideoTranscodeError::Probe("В файле нет видеопотока.".into()))?;
    if streams.is_empty() {
        return Err(VideoTranscodeError::Probe(
            "В файле нет видеопотока.".into(),
        ));
    }

    let stream = &streams[0];
    let width = json_i32(stream.get("width")).unwrap_or(0);
    let height = json_i32(stream.get("height")).unwrap_or(0);

    let mut duration_ms = 0_i32;
    if let Some(format) = root.get("format")
        && let Some(dur) = json_string(format.get("duration"))
        && let Ok(seconds) = dur.parse::<f64>()
    {
        duration_ms = (seconds * 1000.0).round() as i32;
    }

    if width <= 0 || height <= 0 {
        return Err(VideoTranscodeError::Probe(
            "Не удалось определить размеры видео.".into(),
        ));
    }

    Ok(VideoProbeResult {
        width,
        height,
        duration_ms,
    })
}

fn json_i32(v: Option<&serde_json::Value>) -> Option<i32> {
    match v? {
        serde_json::Value::Number(n) => n.as_i64().map(|x| x as i32),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
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
) -> Result<(i32, String, String), VideoTranscodeError> {
    let mut child = Command::new(file_name)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            VideoTranscodeError::Transcode(format!(
                "Не удалось запустить процесс '{file_name}': {e}"
            ))
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
        Ok(Err(e)) => Err(VideoTranscodeError::Transcode(format!(
            "Не удалось запустить процесс '{file_name}': {e}"
        ))),
        Err(_) => Err(VideoTranscodeError::Transcode(format!(
            "Процесс '{file_name}' превысил лимит времени."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_message_matches_csharp() {
        assert_eq!(
            VideoTranscodeError::Unavailable.message(),
            "Обработка видео временно недоступна (на сервере не настроен ffmpeg с SVT-AV1)."
        );
    }

    #[test]
    fn probe_json_parses_width_height_duration() {
        let json = r#"{
            "streams": [{"width": 1920, "height": 1080}],
            "format": {"duration": "12.5"}
        }"#;
        let p = parse_probe_json(json).unwrap();
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        assert_eq!(p.duration_ms, 12500);
    }

    #[test]
    fn probe_rejects_missing_video_stream() {
        let err = parse_probe_json(r#"{"streams":[]}"#).unwrap_err();
        assert_eq!(
            err,
            VideoTranscodeError::Probe("В файле нет видеопотока.".into())
        );
    }

    #[test]
    fn media_options_default() {
        let o = MediaOptions::default();
        assert_eq!(o.ffmpeg_path, "ffmpeg");
        assert_eq!(o.ffprobe_path, "");
    }
}
