//! FSA-A — поиск по музыке (треки). Спека: `Documents/fsa/FSA-A.md`.
//! Владелец данных — Social Music. Fuzzy и точное совпадение названия/артиста
//! критичны для домена (опечатки в именах артистов — норма).

use fsa_contracts::{PersonalizationLevel, SearchDomain, affinity_key};

use crate::document::Document;
use crate::engine::{SearchEngine, SearchFilters, SearchRequest, SearchResponse};
use crate::error::FsaError;
use crate::personalization::PersonalizationContext;
use crate::profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub const FIELD_TITLE: &str = "title";
pub const FIELD_ARTIST: &str = "artist";
pub const FIELD_ALBUM: &str = "album";
pub const FIELD_TAGS: &str = "tags";

pub const ATTR_ARTIST_ID: &str = "artist_id";
pub const ATTR_ALBUM_ID: &str = "album_id";
pub const ATTR_GENRE: &str = "genre";
pub const ATTR_EXPLICIT: &str = "explicit";

/// Нормативный профиль FSA-A (FSA-A.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Audio,
        fields: vec![
            FieldSpec::new(FIELD_TITLE, 2.0)
                .positions()
                .exact_boost(0.6),
            FieldSpec::new(FIELD_ARTIST, 1.8).exact_boost(0.5),
            FieldSpec::new(FIELD_ALBUM, 1.0),
            FieldSpec::new(FIELD_TAGS, 0.8),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 90 * 24 * 3600,
                weight: 0.1,
            },
            static_rank_weight: 0.5,
            proximity_weight: 0.15,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 2,
            fuzzy_min_chars: 4,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 0.7 },
        limits: EngineLimits::default(),
    }
}

/// Трек — вход индексации FSA-A.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioTrack {
    pub id: String,
    pub title: String,
    pub artist_name: String,
    pub artist_id: String,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub tags: Vec<String>,
    pub genre: Option<String>,
    pub explicit: bool,
    /// Unix-секунды публикации релиза.
    pub published_at: i64,
    /// Нормированная популярность `[0, 1]` (глобальная).
    pub popularity_rank: f64,
}

impl AudioTrack {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id)
            .timestamp(self.published_at)
            .static_rank(self.popularity_rank)
            .field(FIELD_TITLE, self.title)
            .field(FIELD_ARTIST, self.artist_name)
            .attr(ATTR_ARTIST_ID, self.artist_id.clone())
            .attr(ATTR_EXPLICIT, bool_attr(self.explicit))
            .personal_key(affinity_key::artist(&self.artist_id));
        if let Some(album) = self.album {
            doc = doc.field(FIELD_ALBUM, album);
        }
        if let Some(album_id) = self.album_id {
            doc = doc.attr(ATTR_ALBUM_ID, album_id);
        }
        for tag in self.tags {
            doc = doc.field(FIELD_TAGS, tag);
        }
        if let Some(genre) = self.genre {
            doc = doc
                .attr(ATTR_GENRE, genre.clone())
                .personal_key(affinity_key::genre(&genre));
        }
        doc
    }
}

fn bool_attr(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

/// Параметры поиска FSA-A.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub personalization: PersonalizationLevel,
    pub artist_id: Option<String>,
    pub genre: Option<String>,
    /// `true` — исключить explicit-треки.
    pub exclude_explicit: bool,
}

impl AudioQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            artist_id: None,
            genre: None,
            exclude_explicit: false,
        }
    }
}

/// Поисковый движок FSA-A.
pub struct AudioSearch {
    engine: SearchEngine,
}

impl AudioSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-A profile is valid"),
        }
    }

    pub fn upsert(&mut self, track: AudioTrack) -> Result<(), FsaError> {
        self.engine.upsert(track.into_document())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.engine.remove(id)
    }

    pub fn len(&self) -> usize {
        self.engine.len()
    }

    pub fn is_empty(&self) -> bool {
        self.engine.is_empty()
    }

    pub fn compact(&mut self) {
        self.engine.compact();
    }

    pub fn engine(&self) -> &SearchEngine {
        &self.engine
    }

    pub fn search(
        &self,
        query: &AudioQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if let Some(artist_id) = &query.artist_id {
            filters = filters.require(ATTR_ARTIST_ID, artist_id.clone());
        }
        if let Some(genre) = &query.genre {
            filters = filters.require(ATTR_GENRE, genre.clone());
        }
        if query.exclude_explicit {
            filters = filters.exclude(ATTR_EXPLICIT, "true");
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .personalization(query.personalization)
            .filters(filters);
        self.engine.search(&request, context)
    }
}

impl Default for AudioSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: &str, popularity: f64) -> AudioTrack {
        AudioTrack {
            id: id.into(),
            title: title.into(),
            artist_name: artist.into(),
            artist_id: format!("artist-{artist}"),
            album: None,
            album_id: None,
            tags: Vec::new(),
            genre: Some("rock".into()),
            explicit: false,
            published_at: 0,
            popularity_rank: popularity,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-A profile");
    }

    #[test]
    fn artist_typo_is_recovered_by_fuzzy() {
        let mut search = AudioSearch::new();
        search
            .upsert(track("t1", "Enter Sandman", "Metallica", 0.9))
            .expect("upsert");
        let response = search.search(&AudioQuery::new("metalica", 100), None);
        assert_eq!(response.matched_total, 1);
        assert_eq!(response.hits[0].id, "t1");
    }

    #[test]
    fn popularity_prior_breaks_text_ties() {
        let mut search = AudioSearch::new();
        search
            .upsert(track("obscure", "Nothing Else", "Band", 0.0))
            .expect("upsert");
        search
            .upsert(track("popular", "Nothing Else", "Band", 1.0))
            .expect("upsert");
        let response = search.search(&AudioQuery::new("nothing else", 100), None);
        assert_eq!(response.hits[0].id, "popular");
    }

    #[test]
    fn explicit_filter_excludes() {
        let mut search = AudioSearch::new();
        let mut explicit = track("e1", "Song", "A", 0.5);
        explicit.explicit = true;
        search.upsert(explicit).expect("upsert");
        search
            .upsert(track("c1", "Song", "B", 0.5))
            .expect("upsert");
        let mut query = AudioQuery::new("song", 100);
        query.exclude_explicit = true;
        let response = search.search(&query, None);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].id, "c1");
    }
}
