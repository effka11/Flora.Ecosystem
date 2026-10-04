//! Фоновые воркеры Music — паритет с MusicArtistBackfill / OrphanCleanup HostedService.

use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeDelta, Utc};
use flora_shared::flora_uuid::new_uuid;
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::application::credits::resolve_role;
use crate::domain::artist_name;
use crate::domain::display_parser;
use crate::infrastructure::repo::{MusicRepo, NewTrackArtistRow};

const ORPHAN_TTL: Duration = Duration::from_secs(3600);
const ORPHAN_INTERVAL: Duration = Duration::from_secs(300);

/// Запускает one-shot backfill + orphan loop (каждые 5 мин).
pub fn spawn_workers(pool: PgPool) -> Vec<JoinHandle<()>> {
    let repo_backfill = Arc::new(MusicRepo::new(pool.clone()));
    let backfill = tokio::spawn(async move {
        if let Err(e) = run_backfill(repo_backfill).await {
            tracing::warn!(error = %e, "Music artist backfill skipped or failed.");
        }
    });

    let repo_orphan = Arc::new(MusicRepo::new(pool));
    let orphan = tokio::spawn(async move {
        loop {
            match run_orphan_cleanup(repo_orphan.clone()).await {
                Ok(deleted) if deleted > 0 => {
                    tracing::info!(
                        count = deleted,
                        ttl_hours = 1,
                        "Music artist orphan cleanup: removed {deleted} artist(s) without tracks older than 1 hour(s)."
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(error = %e, "Music artist orphan cleanup skipped or failed.");
                }
            }
            tokio::time::sleep(ORPHAN_INTERVAL).await;
        }
    });

    vec![backfill, orphan]
}

async fn run_backfill(repo: Arc<MusicRepo>) -> Result<(), sqlx::Error> {
    let tracks = repo.list_tracks_for_backfill().await?;
    for (track_uuid, owner, artist_display) in tracks {
        if repo.track_has_artists(track_uuid).await? {
            continue;
        }
        let segments = display_parser::parse(&artist_display);
        if segments.is_empty() {
            continue;
        }

        let mut sort_order = 0i32;
        let mut credits = Vec::new();
        for segment in segments {
            if !artist_name::is_valid_display_name(&segment.display_name) {
                continue;
            }
            let name = segment.display_name.trim();
            let normalized = artist_name::normalize(name);
            let artist_uuid = if let Some((id, _)) = repo
                .find_by_normalized_name_and_creator(&normalized, owner)
                .await?
            {
                id
            } else {
                let id = new_uuid();
                repo.insert_artist(id, name, &normalized, None, owner, None, None, Utc::now())
                    .await?;
                id
            };

            let joiner = segment.joiner_before;
            let role = resolve_role(joiner, sort_order as usize);
            credits.push(NewTrackArtistRow {
                music_track_artist_uuid: new_uuid(),
                track_uuid,
                artist_uuid,
                role,
                joiner_before: joiner,
                sort_order,
            });
            sort_order += 1;
        }

        if credits.is_empty() {
            continue;
        }
        repo.insert_track_artists(&credits).await?;
    }
    repo.rebuild_tracks_count().await?;
    Ok(())
}

async fn run_orphan_cleanup(repo: Arc<MusicRepo>) -> Result<u64, sqlx::Error> {
    let cutoff =
        Utc::now() - TimeDelta::from_std(ORPHAN_TTL).unwrap_or_else(|_| TimeDelta::hours(1));
    repo.delete_orphaned_artists(cutoff).await
}
