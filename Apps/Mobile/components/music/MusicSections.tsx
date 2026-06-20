import { Ionicons } from "@expo/vector-icons";
import {
  apiCreateMusicArtist,
  apiCreateMusicPlaylist,
  apiDeleteMusicTrack,
  apiGetMusicFlowWave,
  apiSearchMusicArtists,
} from "@flora/client-core/api";
import type { MusicArtistSummaryDto, TrackArtistCreditInput } from "@flora/client-core/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { MusicTrackRow } from "@/components/music/MusicTrackRow";
import {
  MUSIC_DEFAULT_COVER_ID,
  MUSIC_DEFAULT_COVERS,
  MUSIC_DEFAULT_TRACK_KIND_ID,
  MUSIC_GENRES,
  MUSIC_LICENSE_OPTIONS,
  MUSIC_TRACK_KINDS,
} from "@/lib/music/musicCatalog";
import type { MusicTrackItem, PlaylistItem } from "@/lib/music/musicModels";
import { musicTrackDtosToPlayerTracks, musicTrackItemsToPlayerTracks } from "@/lib/music/musicPlayerMapping";
import {
  formatFileSizeRu,
  type PickedMusicFile,
  uploadMusicTrackPlatform,
  uploadMusicTrackSelf,
  validateMusicCoverFile,
  validateMusicUploadFile,
} from "@/lib/music/musicUpload";
import { pickMusicAudioFile, pickMusicCoverFile } from "@/lib/music/musicMediaPickers";
import { useMusicStore } from "@/stores/musicStore";
import { floraColors, floraSpacing } from "@/lib/theme";

const FLOW_WAVE_SIZE = 12;

function SectionHeader({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionAction}>{action}</Text> : null}
    </View>
  );
}

export function MusicFlowCard({
  genreId,
  subgenreId,
  title = "Мой поток",
  subtitle = "Бесконечная волна рекомендаций",
}: {
  genreId?: string;
  subgenreId?: string;
  title?: string;
  subtitle?: string;
}) {
  const playQueue = useMusicStore((s) => s.playQueue);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const current = useMusicStore((s) => s.current);
  const playing = useMusicStore((s) => s.playing);
  const sourceId = useMusicStore((s) => s.sourceId);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playedIdsRef = useRef<Set<string>>(new Set());
  const scopedSourceId = subgenreId
    ? `flow:${genreId}:${subgenreId}`
    : genreId
      ? `flow:${genreId}`
      : "flow";
  const active = sourceId === scopedSourceId && current !== null;

  const loadMore = useCallback(async () => {
    const wave = await apiGetMusicFlowWave({
      take: FLOW_WAVE_SIZE,
      genreId,
      subgenreId,
      excludeTrackUuids: [...playedIdsRef.current],
    });
    if (wave.tracks.length === 0 && playedIdsRef.current.size > 0) {
      playedIdsRef.current = new Set();
      const retry = await apiGetMusicFlowWave({ take: FLOW_WAVE_SIZE, genreId, subgenreId });
      retry.tracks.forEach((track) => playedIdsRef.current.add(track.trackUuid));
      return musicTrackDtosToPlayerTracks(retry.tracks);
    }
    wave.tracks.forEach((track) => playedIdsRef.current.add(track.trackUuid));
    return musicTrackDtosToPlayerTracks(wave.tracks);
  }, [genreId, subgenreId]);

  const startFlow = useCallback(async () => {
    if (active) {
      togglePlay();
      return;
    }
    setStarting(true);
    setError(null);
    try {
      playedIdsRef.current = new Set();
      const tracks = await loadMore();
      if (tracks.length === 0) {
        setError("Поток пока пуст.");
        return;
      }
      playQueue(tracks, 0, { sourceId: scopedSourceId, loadMore });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось запустить поток.");
    } finally {
      setStarting(false);
    }
  }, [active, loadMore, playQueue, scopedSourceId, togglePlay]);

  return (
    <View style={styles.flowCard}>
      <View style={styles.flowArt}>
        <Ionicons name="sparkles" size={26} color={floraColors.greenDark} />
      </View>
      <View style={styles.flowMeta}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardSubtitle}>{active && current ? current.title : subtitle}</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
      <Pressable style={({ pressed }) => [styles.roundBtn, pressed && styles.pressed]} onPress={() => void startFlow()}>
        {starting ? (
          <ActivityIndicator color={floraColors.greenDark} />
        ) : (
          <Ionicons name={active && playing ? "pause" : "play"} size={20} color={floraColors.greenDark} />
        )}
      </Pressable>
    </View>
  );
}

export function MusicGenresCarousel() {
  return (
    <View style={styles.section}>
      <SectionHeader title="Жанры" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalList}>
        {MUSIC_GENRES.map((genre) => (
          <Pressable
            key={genre.id}
            style={({ pressed }) => [styles.genreCard, pressed && styles.pressed]}
            onPress={() =>
              router.push({ pathname: "/(tabs)/music/genre/[genreId]", params: { genreId: genre.id } })
            }
          >
            <Ionicons name="radio-outline" size={20} color={floraColors.greenLight} />
            <Text style={styles.genreTitle}>{genre.title}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export function MusicPlaylistsCarousel({
  playlists,
  onCreated,
}: {
  playlists: PlaylistItem[];
  onCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const createPlaylist = async () => {
    const value = title.trim();
    if (!value) return;
    setBusy(true);
    try {
      await apiCreateMusicPlaylist(value);
      setTitle("");
      setCreating(false);
      onCreated();
    } catch (err) {
      Alert.alert("Плейлист", err instanceof Error ? err.message : "Не удалось создать плейлист.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <SectionHeader title="Плейлисты" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalList}>
        <Pressable
          style={({ pressed }) => [styles.playlistCard, styles.createCard, pressed && styles.pressed]}
          onPress={() => setCreating((value) => !value)}
        >
          <Ionicons name="add" size={24} color={floraColors.greenLight} />
          <Text style={styles.playlistTitle}>Создать</Text>
        </Pressable>
        {playlists.map((playlist) => (
          <Pressable
            key={playlist.id}
            style={({ pressed }) => [styles.playlistCard, pressed && styles.pressed]}
            onPress={() =>
              router.push({ pathname: "/(tabs)/music/playlist/[playlistId]", params: { playlistId: playlist.id } })
            }
          >
            <View style={[styles.playlistCover, { backgroundColor: playlist.coverColor }]} />
            <Text style={styles.playlistTitle} numberOfLines={2}>
              {playlist.title}
            </Text>
            <Text style={styles.playlistCount}>{playlist.trackCount} тр.</Text>
          </Pressable>
        ))}
      </ScrollView>
      {creating ? (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.input}
            placeholder="Название плейлиста"
            placeholderTextColor={floraColors.gray}
            value={title}
            onChangeText={setTitle}
          />
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, busy && styles.disabled]}
            onPress={() => void createPlaylist()}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>{busy ? "Создание…" : "Создать"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function MusicTracksList({
  title = "Треки",
  tracks,
  sourceId = "tracks",
  onDelete,
}: {
  title?: string;
  tracks: MusicTrackItem[];
  sourceId?: string;
  onDelete?: (track: MusicTrackItem) => Promise<void> | void;
}) {
  const playQueue = useMusicStore((s) => s.playQueue);
  const current = useMusicStore((s) => s.current);
  const playing = useMusicStore((s) => s.playing);

  if (tracks.length === 0) {
    return <Text style={styles.emptyHint}>Треков пока нет.</Text>;
  }

  return (
    <View style={styles.section}>
      <SectionHeader title={title} />
      <View style={styles.trackList}>
        {tracks.map((track, index) => (
          <MusicTrackRow
            key={track.id}
            track={track}
            playing={playing && current?.id === track.id}
            onPress={() => playQueue(musicTrackItemsToPlayerTracks(tracks), index, { sourceId })}
            onDelete={
              onDelete
                ? () => {
                    Alert.alert("Удалить трек", `Удалить «${track.title}»?`, [
                      { text: "Отмена", style: "cancel" },
                      { text: "Удалить", style: "destructive", onPress: () => void onDelete(track) },
                    ]);
                  }
                : undefined
            }
          />
        ))}
      </View>
    </View>
  );
}

export function MusicSearchResults({ query, tracks }: { query: string; tracks: MusicTrackItem[] }) {
  const q = query.trim().toLowerCase();
  const foundTracks = useMemo(() => {
    if (!q) return [];
    return tracks.filter((track) => `${track.title} ${track.artist}`.toLowerCase().includes(q));
  }, [q, tracks]);
  const foundGenres = useMemo(() => {
    if (!q) return [];
    return MUSIC_GENRES.filter((genre) => genre.title.toLowerCase().includes(q));
  }, [q]);

  if (!q) return null;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {foundGenres.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Жанры" />
          {foundGenres.map((genre) => (
            <Pressable
              key={genre.id}
              style={({ pressed }) => [styles.searchRow, pressed && styles.pressed]}
              onPress={() =>
                router.push({ pathname: "/(tabs)/music/genre/[genreId]", params: { genreId: genre.id } })
              }
            >
              <Ionicons name="radio-outline" size={18} color={floraColors.greenLight} />
              <Text style={styles.searchTitle}>{genre.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <MusicTracksList title="Треки" tracks={foundTracks} sourceId="search" />
      {foundTracks.length === 0 && foundGenres.length === 0 ? (
        <Text style={styles.emptyHint}>Ничего не найдено.</Text>
      ) : null}
    </ScrollView>
  );
}

export function MyMusicSection({
  tracks,
  playlists,
  refreshing,
  onRefresh,
}: {
  tracks: MusicTrackItem[];
  playlists: PlaylistItem[];
  refreshing?: boolean;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();

  const deleteTrack = async (track: MusicTrackItem) => {
    await apiDeleteMusicTrack(track.id);
    await queryClient.invalidateQueries({ queryKey: ["music-library"] });
    onRefresh();
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {refreshing ? <ActivityIndicator color={floraColors.greenLight} style={styles.loader} /> : null}
      <MusicPlaylistsCarousel playlists={playlists} onCreated={onRefresh} />
      <MusicTracksList title="Моя музыка" tracks={tracks} sourceId="library" onDelete={deleteTrack} />
    </ScrollView>
  );
}

export function RecommendationsSection() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <MusicFlowCard />
      <MusicGenresCarousel />
    </ScrollView>
  );
}

export function MusicArtistPicker({
  value,
  onChange,
}: {
  value: TrackArtistCreditInput[];
  onChange: (credits: TrackArtistCreditInput[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const search = useQuery({
    queryKey: ["music-artists-search", query.trim()],
    enabled: query.trim().length >= 2,
    queryFn: () => apiSearchMusicArtists(query.trim(), 8),
  });
  const selectedUuid = value[0]?.artistUuid ?? "";

  const selectArtist = (artist: MusicArtistSummaryDto) => {
    onChange([{ artistUuid: artist.artistUuid, joinerBefore: "None" }]);
    setQuery(artist.displayName);
  };

  const createArtist = async () => {
    const displayName = query.trim();
    if (!displayName) return;
    setCreating(true);
    try {
      const artist = await apiCreateMusicArtist(displayName, false);
      selectArtist(artist);
    } catch (err) {
      Alert.alert("Исполнитель", err instanceof Error ? err.message : "Не удалось создать исполнителя.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.inlineForm}>
      <Text style={styles.label}>Исполнитель</Text>
      <TextInput
        style={styles.input}
        placeholder="Найти или создать исполнителя"
        placeholderTextColor={floraColors.gray}
        value={query}
        onChangeText={setQuery}
      />
      {search.data?.map((artist) => (
        <Pressable
          key={artist.artistUuid}
          style={({ pressed }) => [styles.artistRow, selectedUuid === artist.artistUuid && styles.artistSelected, pressed && styles.pressed]}
          onPress={() => selectArtist(artist)}
        >
          <Text style={styles.artistName}>{artist.displayName}</Text>
          <Text style={styles.artistCount}>{artist.tracksCount} тр.</Text>
        </Pressable>
      ))}
      {query.trim().length >= 2 ? (
        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed, creating && styles.disabled]}
          onPress={() => void createArtist()}
          disabled={creating}
        >
          <Text style={styles.secondaryBtnText}>{creating ? "Создание…" : "Создать исполнителя"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function MusicUploadForSelfForm({ onUploaded }: { onUploaded: () => void }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [tags, setTags] = useState("");
  const [coverColorId, setCoverColorId] = useState(MUSIC_DEFAULT_COVER_ID);
  const [trackKindId, setTrackKindId] = useState(MUSIC_DEFAULT_TRACK_KIND_ID);
  const [file, setFile] = useState<PickedMusicFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const chooseFile = async () => {
    const next = await pickMusicAudioFile();
    if (!next) return;
    const error = validateMusicUploadFile(next);
    setFileError(error);
    setFile(error ? null : next);
  };

  const upload = async () => {
    if (!file || !title.trim()) return;
    setUploading(true);
    try {
      await uploadMusicTrackSelf({
        file,
        title: title.trim(),
        artist: artist.trim(),
        tags,
        coverColorId,
        trackKindId,
      });
      setTitle("");
      setArtist("");
      setTags("");
      setFile(null);
      onUploaded();
    } catch (err) {
      Alert.alert("Загрузка", err instanceof Error ? err.message : "Не удалось загрузить трек.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.uploadCard}>
      <SectionHeader title="Загрузить для себя" />
      <FilePickerButton file={file} error={fileError} onPick={() => void chooseFile()} />
      <TextInput style={styles.input} placeholder="Название" placeholderTextColor={floraColors.gray} value={title} onChangeText={setTitle} />
      <TextInput style={styles.input} placeholder="Исполнитель" placeholderTextColor={floraColors.gray} value={artist} onChangeText={setArtist} />
      <TextInput style={styles.input} placeholder="Теги" placeholderTextColor={floraColors.gray} value={tags} onChangeText={setTags} />
      <PalettePicker activeId={coverColorId} onSelect={setCoverColorId} />
      <ChipPicker items={MUSIC_TRACK_KINDS} activeId={trackKindId} onSelect={(id) => setTrackKindId(id)} />
      <Pressable
        style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, (!file || !title.trim() || uploading) && styles.disabled]}
        onPress={() => void upload()}
        disabled={!file || !title.trim() || uploading}
      >
        <Text style={styles.primaryBtnText}>{uploading ? "Загрузка…" : "Загрузить"}</Text>
      </Pressable>
    </View>
  );
}

export function MusicUploadForPlatformForm({ onUploaded }: { onUploaded: () => void }) {
  const [title, setTitle] = useState("");
  const [artistCredits, setArtistCredits] = useState<TrackArtistCreditInput[]>([]);
  const [genreId, setGenreId] = useState(MUSIC_GENRES[0]!.id);
  const [licenseId, setLicenseId] = useState<(typeof MUSIC_LICENSE_OPTIONS)[number]["id"]>(
    MUSIC_LICENSE_OPTIONS[0]!.id,
  );
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [file, setFile] = useState<PickedMusicFile | null>(null);
  const [cover, setCover] = useState<PickedMusicFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const chooseFile = async () => {
    const next = await pickMusicAudioFile();
    if (!next) return;
    const error = validateMusicUploadFile(next);
    setFileError(error);
    setFile(error ? null : next);
  };

  const chooseCover = async () => {
    const next = await pickMusicCoverFile();
    if (!next) return;
    const error = validateMusicCoverFile(next);
    setCoverError(error);
    setCover(error ? null : next);
  };

  const upload = async () => {
    if (!file || !title.trim() || artistCredits.length === 0 || !termsAccepted) return;
    setUploading(true);
    try {
      await uploadMusicTrackPlatform({
        file,
        title: title.trim(),
        artistCredits,
        genreId,
        licenseId,
        termsAccepted,
        cover,
      });
      setTitle("");
      setArtistCredits([]);
      setFile(null);
      setCover(null);
      setTermsAccepted(false);
      onUploaded();
    } catch (err) {
      Alert.alert("Загрузка", err instanceof Error ? err.message : "Не удалось загрузить трек.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.uploadCard}>
      <SectionHeader title="Загрузить на площадку" />
      <FilePickerButton file={file} error={fileError} onPick={() => void chooseFile()} />
      <TextInput style={styles.input} placeholder="Название" placeholderTextColor={floraColors.gray} value={title} onChangeText={setTitle} />
      <MusicArtistPicker value={artistCredits} onChange={setArtistCredits} />
      <ChipPicker items={MUSIC_GENRES} activeId={genreId} onSelect={setGenreId} />
      <ChipPicker items={MUSIC_LICENSE_OPTIONS} activeId={licenseId} onSelect={setLicenseId} />
      <FilePickerButton label="Обложка (необязательно)" file={cover} error={coverError} onPick={() => void chooseCover()} />
      <Pressable style={({ pressed }) => [styles.checkboxRow, pressed && styles.pressed]} onPress={() => setTermsAccepted((value) => !value)}>
        <View style={[styles.checkbox, termsAccepted && styles.checkboxOn]}>
          {termsAccepted ? <Ionicons name="checkmark" size={14} color={floraColors.greenDark} /> : null}
        </View>
        <Text style={styles.checkboxText}>Я подтверждаю права на публикацию трека.</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.primaryBtn,
          pressed && styles.pressed,
          (!file || !title.trim() || artistCredits.length === 0 || !termsAccepted || uploading) && styles.disabled,
        ]}
        onPress={() => void upload()}
        disabled={!file || !title.trim() || artistCredits.length === 0 || !termsAccepted || uploading}
      >
        <Text style={styles.primaryBtnText}>{uploading ? "Загрузка…" : "Опубликовать"}</Text>
      </Pressable>
    </View>
  );
}

export function AddTrackSection({
  uploadMode,
  onUploaded,
}: {
  uploadMode: "forSelf" | "forPlatform";
  onUploaded: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {uploadMode === "forSelf" ? (
        <MusicUploadForSelfForm onUploaded={onUploaded} />
      ) : (
        <MusicUploadForPlatformForm onUploaded={onUploaded} />
      )}
    </ScrollView>
  );
}

function FilePickerButton({
  label = "Аудиофайл",
  file,
  error,
  onPick,
}: {
  label?: string;
  file: PickedMusicFile | null;
  error?: string | null;
  onPick: () => void;
}) {
  return (
    <View style={styles.inlineForm}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={({ pressed }) => [styles.filePicker, pressed && styles.pressed]} onPress={onPick}>
        <Ionicons name="cloud-upload-outline" size={20} color={floraColors.greenLight} />
        <View style={styles.fileMeta}>
          <Text style={styles.fileTitle} numberOfLines={1}>
            {file?.name ?? "Выбрать файл"}
          </Text>
          <Text style={styles.fileSize}>{file ? formatFileSizeRu(file.size) : "MP3, M4A, FLAC, WAV и др."}</Text>
        </View>
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function PalettePicker({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  return (
    <View style={styles.inlineForm}>
      <Text style={styles.label}>Цвет обложки</Text>
      <View style={styles.palette}>
        {MUSIC_DEFAULT_COVERS.map((cover) => (
          <Pressable
            key={cover.id}
            accessibilityRole="button"
            accessibilityState={{ selected: cover.id === activeId }}
            style={[
              styles.paletteDot,
              { backgroundColor: cover.color },
              cover.id === activeId && styles.paletteDotActive,
            ]}
            onPress={() => onSelect(cover.id)}
          />
        ))}
      </View>
    </View>
  );
}

function ChipPicker<T extends string>({
  items,
  activeId,
  onSelect,
}: {
  items: readonly { id: T; label?: string; title?: string }[];
  activeId: string;
  onSelect: (id: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      {items.map((item) => {
        const selected = item.id === activeId;
        return (
          <Pressable
            key={item.id}
            style={({ pressed }) => [styles.chip, selected && styles.chipActive, pressed && styles.pressed]}
            onPress={() => onSelect(item.id)}
          >
            <Text style={[styles.chipText, selected && styles.chipTextActive]}>{item.label ?? item.title}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: floraSpacing.grid,
    paddingBottom: floraSpacing.grid * 7,
    gap: floraSpacing.grid,
  },
  section: {
    gap: floraSpacing.gridFine * 2,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: floraSpacing.grid,
  },
  sectionTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
  },
  sectionAction: {
    color: floraColors.gray,
    fontSize: 12,
  },
  flowCard: {
    marginHorizontal: floraSpacing.grid,
    padding: floraSpacing.grid,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.26)",
    backgroundColor: "rgba(164, 209, 138, 0.1)",
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  flowArt: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: floraColors.greenLight,
    alignItems: "center",
    justifyContent: "center",
  },
  flowMeta: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 19,
    fontWeight: "300",
    letterSpacing: 0.57,
  },
  cardSubtitle: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
    marginTop: 3,
  },
  roundBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
  },
  horizontalList: {
    gap: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
  },
  genreCard: {
    width: 132,
    minHeight: 86,
    borderRadius: 18,
    padding: floraSpacing.grid,
    justifyContent: "space-between",
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
  },
  genreTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  playlistCard: {
    width: 132,
    minHeight: 150,
    borderRadius: 18,
    padding: floraSpacing.grid,
    gap: floraSpacing.gridFine,
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
  },
  createCard: {
    alignItems: "center",
    justifyContent: "center",
  },
  playlistCover: {
    height: 78,
    borderRadius: 16,
    marginBottom: floraSpacing.gridFine,
  },
  playlistTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
    fontWeight: "300",
  },
  playlistCount: {
    color: floraColors.gray,
    fontSize: 12,
  },
  trackList: {
    backgroundColor: floraColors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
  },
  searchRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.grid,
  },
  searchTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  uploadCard: {
    marginHorizontal: floraSpacing.grid,
    padding: floraSpacing.grid,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: floraColors.surface,
    gap: floraSpacing.grid,
  },
  inlineForm: {
    gap: floraSpacing.gridFine * 2,
  },
  label: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
  },
  input: {
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    color: floraColors.whiteTemplate,
    paddingHorizontal: 14,
    fontSize: 15,
    fontWeight: "300",
  },
  filePicker: {
    minHeight: 58,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: floraSpacing.grid,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
  },
  fileMeta: {
    flex: 1,
    minWidth: 0,
  },
  fileTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
    fontWeight: "300",
  },
  fileSize: {
    color: floraColors.gray,
    fontSize: 12,
    marginTop: 2,
  },
  palette: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: floraSpacing.gridFine * 2,
  },
  paletteDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: "transparent",
  },
  paletteDotActive: {
    borderColor: floraColors.whiteTemplate,
  },
  chips: {
    gap: floraSpacing.gridFine * 2,
    paddingRight: floraSpacing.grid,
  },
  chip: {
    minHeight: 34,
    borderRadius: 999,
    paddingHorizontal: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
  },
  chipActive: {
    borderColor: floraColors.greenLight,
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  chipText: {
    color: floraColors.gray,
    fontSize: 13,
  },
  chipTextActive: {
    color: floraColors.greenLight,
  },
  artistRow: {
    minHeight: 42,
    borderRadius: 12,
    paddingHorizontal: floraSpacing.grid,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(250, 250, 250, 0.04)",
  },
  artistSelected: {
    borderWidth: 1,
    borderColor: floraColors.greenLight,
  },
  artistName: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
  },
  artistCount: {
    color: floraColors.gray,
    fontSize: 12,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: floraColors.greenDark,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: floraColors.greenLight,
    borderColor: floraColors.greenLight,
  },
  checkboxText: {
    flex: 1,
    color: floraColors.gray,
    fontSize: 13,
    lineHeight: 18,
  },
  primaryBtn: {
    minHeight: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
    paddingHorizontal: floraSpacing.grid * 2,
  },
  primaryBtnText: {
    color: floraColors.greenDark,
    fontSize: 15,
    fontWeight: "300",
  },
  secondaryBtn: {
    minHeight: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: floraColors.greenDark,
  },
  secondaryBtnText: {
    color: floraColors.greenLight,
    fontSize: 13,
  },
  loader: {
    marginTop: floraSpacing.grid,
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid * 2,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  errorText: {
    color: floraColors.error,
    fontSize: 12,
    lineHeight: 17,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.5,
  },
});
