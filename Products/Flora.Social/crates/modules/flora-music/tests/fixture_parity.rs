//! Паритет wire DTO с contract fixtures (artifacts/contract-fixtures/music-*.json).

use flora_music_contracts::{
    MusicGenreCatalogDto, MusicPlaylistDetailDto, MusicPlaylistSummaryDto, MusicTrackDto,
};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../artifacts/contract-fixtures")
        .canonicalize()
        .expect("artifacts/contract-fixtures")
}

fn load(name: &str) -> serde_json::Value {
    let path = fixtures_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("json")
}

#[test]
fn music_library_fixture_deserializes_tracks() {
    let root = load("music-library.json");
    let tracks: Vec<MusicTrackDto> =
        serde_json::from_value(root["tracks"].clone()).expect("tracks");
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0].scope, "personal");
    assert_eq!(tracks[0].artist_credits[0].joiner_before, "None");
    assert!(tracks[1].tags.is_none());
}

#[test]
fn music_playlists_fixture_uses_uploaded_ids() {
    let root = load("music-playlists.json");
    let playlists: Vec<MusicPlaylistSummaryDto> =
        serde_json::from_value(root["playlists"].clone()).expect("playlists");
    assert_eq!(playlists[0].id, "uploaded-personal");
    assert_eq!(playlists[0].kind, "system");
    assert_eq!(playlists[2].kind, "user");
}

#[test]
fn music_playlist_detail_and_genres_fixtures() {
    let detail: MusicPlaylistDetailDto =
        serde_json::from_value(load("music-playlist-detail.json")).expect("detail");
    assert_eq!(detail.id, "uploaded-personal");
    assert_eq!(detail.tracks.len(), 1);

    let genres: MusicGenreCatalogDto =
        serde_json::from_value(load("music-genres.json")).expect("genres");
    assert_eq!(genres.genres[0].id, "pop");
}
