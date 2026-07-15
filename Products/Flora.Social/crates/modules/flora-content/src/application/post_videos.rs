//! Загрузка видео поста + очередь/воркер SVT-AV1 — паритет UploadPostVideo / PostVideoTranscodeWorker.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeDelta, Utc};
use flora_shared::flora_uuid::new_uuid;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::infrastructure::ffmpeg_video::FfmpegVideoTranscoder;
use crate::infrastructure::repo::ContentRepo;

pub const ALLOWED_POST_VIDEO_TYPES: &[&str] = &[
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
];
pub const MAX_POST_VIDEO_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_POST_VIDEO_DURATION_MS: i32 = 10 * 60 * 1000;
const STALE_PROCESSING_AGE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub struct PostVideoTranscodeJob {
    pub video_uuid: Uuid,
    pub temp_input_path: PathBuf,
}

/// In-memory очередь (паритет `PostVideoTranscodeQueue`: SingleReader, multi-writer).
#[derive(Clone)]
pub struct PostVideoTranscodeQueue {
    tx: mpsc::UnboundedSender<PostVideoTranscodeJob>,
}

impl PostVideoTranscodeQueue {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<PostVideoTranscodeJob>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    pub fn enqueue(&self, job: PostVideoTranscodeJob) -> Result<(), String> {
        self.tx
            .send(job)
            .map_err(|_| "Очередь транскодирования закрыта.".to_string())
    }
}

pub struct UploadedVideoFile {
    pub file_name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub enum UploadPostVideoError {
    NotFound,
    Forbidden,
    NoFile,
    FileTooLarge,
    BadType,
    AlreadyHasVideo,
    Unavailable,
    Unreadable,
    TooLong,
}

pub struct PostVideosService {
    repo: Arc<ContentRepo>,
    transcoder: Arc<FfmpegVideoTranscoder>,
    queue: Arc<PostVideoTranscodeQueue>,
}

impl PostVideosService {
    pub fn new(
        repo: Arc<ContentRepo>,
        transcoder: Arc<FfmpegVideoTranscoder>,
        queue: Arc<PostVideoTranscodeQueue>,
    ) -> Self {
        Self {
            repo,
            transcoder,
            queue,
        }
    }

    pub async fn upload(
        &self,
        author: Uuid,
        post_uuid: Uuid,
        file: Option<UploadedVideoFile>,
    ) -> Result<Result<Value, UploadPostVideoError>, String> {
        let Some(post_author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(UploadPostVideoError::NotFound));
        };
        if post_author != author {
            return Ok(Err(UploadPostVideoError::Forbidden));
        }

        let Some(file) = file.filter(|f| !f.bytes.is_empty()) else {
            return Ok(Err(UploadPostVideoError::NoFile));
        };
        if file.bytes.len() as u64 > MAX_POST_VIDEO_BYTES {
            return Ok(Err(UploadPostVideoError::FileTooLarge));
        }
        let content_type = file
            .content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !ALLOWED_POST_VIDEO_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&content_type))
        {
            return Ok(Err(UploadPostVideoError::BadType));
        }
        if self
            .repo
            .post_has_video(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(UploadPostVideoError::AlreadyHasVideo));
        }
        if !self.transcoder.is_available().await {
            return Ok(Err(UploadPostVideoError::Unavailable));
        }

        let ext = Path::new(&file.file_name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let temp_path = std::env::temp_dir().join(format!(
            "flora-upload-{}{ext}",
            Uuid::now_v7().simple()
        ));

        if let Err(e) = tokio::fs::write(&temp_path, &file.bytes).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!("Не удалось сохранить временный файл: {e}"));
        }

        let probe = match self.transcoder.probe(&temp_path).await {
            Ok(p) => p,
            Err(e) => {
                warn!(
                    error = %e,
                    post_uuid = %post_uuid,
                    "Не удалось прочитать загруженное видео"
                );
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Ok(Err(UploadPostVideoError::Unreadable));
            }
        };
        if probe.duration_ms > MAX_POST_VIDEO_DURATION_MS {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Ok(Err(UploadPostVideoError::TooLong));
        }

        let video_uuid = new_uuid();
        if let Err(e) = self
            .repo
            .insert_processing_video(
                video_uuid,
                post_uuid,
                probe.width,
                probe.height,
                probe.duration_ms,
            )
            .await
        {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(e.to_string());
        }

        if let Err(e) = self.queue.enqueue(PostVideoTranscodeJob {
            video_uuid,
            temp_input_path: temp_path.clone(),
        }) {
            let _ = tokio::fs::remove_file(&temp_path).await;
            let _ = self.repo.update_video_failed(video_uuid).await;
            return Err(e);
        }

        Ok(Ok(json!({
            "videoUuid": video_uuid,
            "status": "processing",
        })))
    }
}

/// Части воркера: берутся один раз из `ContentModule` при ServeNative.
pub struct ContentVideoWorker {
    pub repo: Arc<ContentRepo>,
    pub transcoder: Arc<FfmpegVideoTranscoder>,
    pub rx: mpsc::UnboundedReceiver<PostVideoTranscodeJob>,
}

pub fn spawn_video_worker(worker: ContentVideoWorker) -> JoinHandle<()> {
    tokio::spawn(async move {
        run_video_worker(worker).await;
    })
}

async fn run_video_worker(mut worker: ContentVideoWorker) {
    fail_stale_processing(&worker.repo).await;

    while let Some(job) = worker.rx.recv().await {
        if let Err(e) = process_job(&worker.repo, &worker.transcoder, &job).await {
            error!(
                error = %e,
                video_uuid = %job.video_uuid,
                "Необработанная ошибка транскодирования видео"
            );
        }
        try_delete(&job.temp_input_path).await;
    }
}

async fn fail_stale_processing(repo: &ContentRepo) {
    let threshold = Utc::now()
        - TimeDelta::from_std(STALE_PROCESSING_AGE).unwrap_or_else(|_| TimeDelta::minutes(5));
    match repo.fail_stale_processing_videos(threshold).await {
        Ok(n) if n > 0 => {
            warn!(
                count = n,
                "Помечено Failed {n} осиротевших видео (Processing с прошлого запуска)."
            );
        }
        Ok(_) => {}
        Err(e) => {
            warn!(
                error = %e,
                "Не удалось проверить осиротевшие видео (миграции применены?)."
            );
        }
    }
}

async fn process_job(
    repo: &ContentRepo,
    transcoder: &FfmpegVideoTranscoder,
    job: &PostVideoTranscodeJob,
) -> Result<(), String> {
    let Some(_) = repo
        .get_video_for_update(job.video_uuid)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };

    match transcoder.transcode(&job.temp_input_path).await {
        Ok(result) => {
            repo.update_video_ready(
                job.video_uuid,
                &result.video_data,
                &result.video_content_type,
                result.compatibility_video_data.as_deref(),
                result.compatibility_video_content_type.as_deref(),
                &result.poster_data,
                &result.poster_content_type,
                result.width,
                result.height,
                result.duration_ms,
            )
            .await
            .map_err(|e| e.to_string())?;
            info!(
                video_uuid = %job.video_uuid,
                width = result.width,
                height = result.height,
                duration_ms = result.duration_ms,
                size_kb = result.video_data.len() / 1024,
                "Видео готово"
            );
        }
        Err(e) => {
            error!(
                error = %e,
                video_uuid = %job.video_uuid,
                "Транскодирование видео не удалось"
            );
            repo.update_video_failed(job.video_uuid)
                .await
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

async fn try_delete(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}
