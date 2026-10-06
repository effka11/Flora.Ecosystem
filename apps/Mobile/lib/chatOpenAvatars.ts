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

export function __resetChatOpenAvatarWarm(): void {
  inflight.clear();
  clearChatOpenAvatarPaint();
}

export function clearChatOpenAvatarPaint(): void {
  decodedUnpainted.clear();
  painted.clear();
}

/** Декод этого парка не был синхронным попаданием в файл. */
export function noteChatOpenAvatarDecoded(uuid: string): void {
  const id = uuid.trim();
  if (!id || painted.has(id)) return;
  decodedUnpainted.add(id);
}

/** Круг треда (не строка списка) нарисовал bitmap. */
export function noteChatOpenAvatarPainted(uuid: string): void {
  const id = uuid.trim();
  if (!id) return;
  painted.add(id);
  decodedUnpainted.delete(id);
}

/** Среди кругов открытия есть холодный декод без onLoad. */
export function chatOpenAvatarsNeedPaint(uuids: readonly string[]): boolean {
  for (const raw of uuids) {
    const id = raw.trim();
    if (id && decodedUnpainted.has(id)) return true;
  }
  return false;
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
