export type ChatAvatarWarmPace = "cached" | "decoded";

export type ChatAvatarReady = {
  pace: ChatAvatarWarmPace;
  /** Decoded file or legacy URL. Empty when the decode did not finish. */
  uri: string;
};

export type ChatAvatarWarmDeps = {
  displayWidth: number;
  ready: (uuid: string) => Promise<ChatAvatarReady>;
  prefetch: (uris: readonly string[]) => Promise<void>;
};

export type ChatOpenAvatarTail = {
  avatarUuid?: string | null;
};

const inflight = new Map<string, Promise<ChatAvatarReady>>();
/**
 * Холодный декод этого парка, чей круг треда ещё не вызвал onLoad.
 * Синхронный peek сюда не попадает: файл уже был, лишний кадр не нужен.
 * Повторный peek после декода не стирает отметку — иначе закрытие окна
 * решит, что картинка была тёплой, и слайд поедет до первого кадра.
 */
const decodedUnpainted = new Set<string>();
const painted = new Set<string>();
/**
 * Bitmap уже в том memory-cache, который первый кадр `Image` читает.
 * Для локального FRI это `cachePolicy="memory"` (`FloraAvatar`,
 * `isLocalDecodedUri`). Индекс файла на диске сюда не входит.
 */
const firstFrameCache = new Set<string>();
/** Ждут onLoad или prefetch в cache первого кадра (finishParkedAvatarWarm). */
const paintListeners = new Set<() => void>();

/**
 * Политика cache, которую первый кадр круга треда читает у локального файла.
 * Prefetch готовности равен только ей. `memory-disk` и `disk` — другой cache:
 * ковёр ждёт onLoad.
 */
export const CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE = "memory" as const;

export type ChatAvatarImageCache = "memory" | "memory-disk" | "disk";

export function chatOpenAvatarPrefetchFillsFirstFrame(cache: ChatAvatarImageCache): boolean {
  return cache === CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE;
}

export function __resetChatOpenAvatarWarm(): void {
  inflight.clear();
  clearChatOpenAvatarPaint();
  paintListeners.clear();
}

export function clearChatOpenAvatarPaint(): void {
  decodedUnpainted.clear();
  painted.clear();
  firstFrameCache.clear();
}

/** Декод этого парка не был синхронным попаданием в файл. */
export function noteChatOpenAvatarDecoded(uuid: string): void {
  const id = uuid.trim();
  if (!id || painted.has(id) || firstFrameCache.has(id)) return;
  decodedUnpainted.add(id);
}

/** Круг треда (не строка списка) нарисовал bitmap. */
export function noteChatOpenAvatarPainted(uuid: string): void {
  const id = uuid.trim();
  if (!id) return;
  painted.add(id);
  decodedUnpainted.delete(id);
  for (const listener of paintListeners) listener();
}

/**
 * Prefetch попал в cache. Готовность — только если это тот же cache, что
 * читает первый кадр `Image`. Иначе отметка не ставится, ковёр ждёт onLoad.
 */
export function noteChatOpenAvatarPrefetched(uuid: string, cache: ChatAvatarImageCache): void {
  const id = uuid.trim();
  if (!id || !chatOpenAvatarPrefetchFillsFirstFrame(cache)) return;
  firstFrameCache.add(id);
  decodedUnpainted.delete(id);
  for (const listener of paintListeners) listener();
}

/** Среди кругов открытия есть холодный декод без onLoad. */
export function chatOpenAvatarsNeedPaint(uuids: readonly string[]): boolean {
  for (const raw of uuids) {
    const id = raw.trim();
    if (id && decodedUnpainted.has(id)) return true;
  }
  return false;
}

/**
 * Круг готов к первому кадру: его уже нарисовал onLoad, либо prefetch записал
 * тот же memory-cache, что читает `Image`. Файл в индексе (`peek`) после
 * рестарта bitmap не содержит — такой круг не готов.
 * `peek` оставлен в сигнатуре: вызывающий по-прежнему знает индекс, решение
 * о готовности его не читает.
 */
export function chatOpenAvatarsReadyNow(
  uuids: readonly string[],
  peek: (uuid: string) => string,
): boolean {
  for (const raw of uuids) {
    const id = raw.trim();
    if (!id) continue;
    void peek;
    if (painted.has(id) || firstFrameCache.has(id)) continue;
    return false;
  }
  return true;
}

export type ChatOpenAvatarFramePace = "ready" | "capped";

/**
 * Ждать bitmap первого кадра. Потолок отпускает показ, но это не тёплый
 * кадр: ни onLoad, ни prefetch в cache первого кадра не успели.
 */
export function whenChatOpenAvatarsFirstFrame(
  uuids: readonly string[],
  peek: (uuid: string) => string,
  options: {
    timeoutMs: number;
    schedule?: (run: () => void, ms: number) => () => void;
  },
): Promise<ChatOpenAvatarFramePace> {
  if (chatOpenAvatarsReadyNow(uuids, peek)) return Promise.resolve("ready");
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  return new Promise((resolve) => {
    let done = false;
    let cancelTimer: (() => void) | null = null;
    const finish = (pace: ChatOpenAvatarFramePace) => {
      if (done) return;
      done = true;
      paintListeners.delete(onPaint);
      cancelTimer?.();
      resolve(pace);
    };
    const onPaint = () => {
      if (chatOpenAvatarsReadyNow(uuids, peek)) finish("ready");
    };
    paintListeners.add(onPaint);
    cancelTimer = schedule(() => finish("capped"), options.timeoutMs);
  });
}

/**
 * Слайд только после bitmap: ждать onLoad холодных кругов этого парка.
 * Потолок — страховка от круга, который так и не нарисовался (offscreen без
 * layout, ошибка файла): дальше показ как есть, инициалы вместо FRI.
 */
export function whenChatOpenAvatarsPainted(
  uuids: readonly string[],
  options: {
    timeoutMs: number;
    schedule?: (run: () => void, ms: number) => () => void;
  },
): Promise<void> {
  if (!chatOpenAvatarsNeedPaint(uuids)) return Promise.resolve();
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  return new Promise((resolve) => {
    let done = false;
    let cancelTimer: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      paintListeners.delete(onPaint);
      cancelTimer?.();
      resolve();
    };
    const onPaint = () => {
      if (!chatOpenAvatarsNeedPaint(uuids)) finish();
    };
    paintListeners.add(onPaint);
    cancelTimer = schedule(finish, options.timeoutMs);
  });
}

/** Header plus the tails that actually draw a circle. Empty and duplicates drop out. */
export function collectChatOpenAvatarUuids(
  headerAvatarUuid: string | null | undefined,
  tails: readonly ChatOpenAvatarTail[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const id = raw?.trim() ?? "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  add(headerAvatarUuid);
  for (const tail of tails) add(tail.avatarUuid);
  return out;
}

function warmOne(uuid: string, deps: ChatAvatarWarmDeps): Promise<ChatAvatarReady> {
  const key = `${deps.displayWidth}\0${uuid}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = deps.ready(uuid).catch(() => ({ pace: "decoded" as const, uri: "" }));
  inflight.set(key, job);
  void job.finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  return job;
}

/**
 * Файл FRI в память картинки до слайда.
 * `decoded` — хотя бы один круг не был синхронным попаданием в файл, кругу
 * ещё нужен кадр. Синхронный файл уже рисует строка списка: повторный
 * `Image.prefetch` того же URI держит ковёр сотни миллисекунд и битмап не
 * меняет.
 */
export async function warmChatOpenAvatarBitmaps(
  uuids: readonly (string | null | undefined)[],
  deps: ChatAvatarWarmDeps,
): Promise<ChatAvatarWarmPace> {
  const ids = collectChatOpenAvatarUuids(null, uuids.map((avatarUuid) => ({ avatarUuid })));
  if (ids.length === 0) return "cached";
  const results = await Promise.all(ids.map((id) => warmOne(id, deps)));
  const cold = results.some((result) => result.pace === "decoded");
  if (!cold) return "cached";
  const uris = results.map((result) => result.uri).filter((uri) => uri.length > 0);
  if (uris.length > 0) {
    try {
      await deps.prefetch(uris);
    } catch {
      // A failed memory warm must not hold the slide.
    }
  }
  return "decoded";
}
