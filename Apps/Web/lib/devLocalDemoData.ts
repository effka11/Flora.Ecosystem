import type { MeResponse } from "@/lib/auth";
import { floraNewUuid } from "@/lib/floraUuid";
import type { FscpMessagePlaintext } from "@/lib/fscp";
import type {
  ConversationListItemDto,
  FeedPostDto,
  MessageThreadItemDto,
  PostCommentDto,
  ProfilePostDto,
  PublicProfileDto,
} from "@/lib/socialApi";

function demoPayloadListPreview(payload: FscpMessagePlaintext): string {
  const parts: string[] = [];
  for (const block of payload.blocks) {
    if (block.kind === "text") {
      const body = block.body.trim();
      if (body) parts.push(body);
    } else {
      parts.push("Голосовое сообщение");
    }
  }
  return parts.join(" · ");
}

/** Офлайн-чаты: блочный payload без FSCP, только для dev-token. */
export const DEMO_PLAINTEXT_WIRE_PREFIX = "demo1:";

const devVoiceBlobs = new Map<string, Blob>();
const devImageBlobs = new Map<string, Blob>();

export function devRegisterVoiceBlob(assetUuid: string, blob: Blob): void {
  devVoiceBlobs.set(assetUuid, blob);
}

export function devGetVoiceBlob(assetUuid: string): Blob | undefined {
  return devVoiceBlobs.get(assetUuid);
}

export function devRegisterImageBlob(assetUuid: string, blob: Blob): void {
  devImageBlobs.set(assetUuid, blob);
}

export function devGetImageBlob(assetUuid: string): Blob | undefined {
  return devImageBlobs.get(assetUuid);
}

const devVideoBlobs = new Map<string, Blob>();

export function devRegisterVideoBlob(assetUuid: string, blob: Blob): void {
  devVideoBlobs.set(assetUuid, blob);
}

export function devGetVideoBlob(assetUuid: string): Blob | undefined {
  return devVideoBlobs.get(assetUuid);
}

export function isDemoPlaintextWire(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(DEMO_PLAINTEXT_WIRE_PREFIX);
}

export function devPlaintextWire(payload: FscpMessagePlaintext): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${DEMO_PLAINTEXT_WIRE_PREFIX}${btoa(bin)}`;
}

export function parseDemoPlaintextWire(wire: string): FscpMessagePlaintext | null {
  if (!isDemoPlaintextWire(wire)) return null;
  try {
    const bin = atob(wire.slice(DEMO_PLAINTEXT_WIRE_PREFIX.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json) as FscpMessagePlaintext;
    if (obj?.type !== "blocks" || !Array.isArray(obj.blocks)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Профиль для офлайн-ветки `apiGetMe` (совпадает с «владельцем» демо-чатов). */
export const DEV_LOCAL_ME: MeResponse = {
  userUuid: "10000000-0000-4000-8000-000000000001",
  username: "ilya_smirnov",
  displayName: "Илья Смирнов",
  email: "ilya@example.com",
  status: "На связи",
  followersCount: 1204,
  followingCount: 312,
};

/** Базовые строки вкладки «Люди» (офлайн UI). */
export const DEV_DEMO_PEOPLE_BASE = [
  { id: "flora", displayName: "Flora Team", username: "@flora", followers: 2418 },
  { id: "luna", displayName: "Luna Community", username: "@luna", followers: 1284 },
  { id: "garden", displayName: "Green Garden", username: "@garden", followers: 936 },
  { id: "river", displayName: "River Hub", username: "@river", followers: 612 },
] as const;

const EXTRA_FIRST = [
  "Марина",
  "Степан",
  "Таисия",
  "Артём",
  "Камилла",
  "Денис",
  "Софья",
  "Никита",
  "Алина",
  "Влад",
  "Мария",
  "Павел",
  "Ксения",
  "Ольга",
  "Игорь",
  "Наталья",
  "Сергей",
  "Виктория",
  "Андрей",
  "Екатерина",
];

const EXTRA_LAST = [
  "Ковалёва",
  "Волков",
  "Орлова",
  "Семёнова",
  "Зайцева",
  "Белова",
  "Громова",
  "Ефимова",
  "Рыбакова",
  "Широкова",
  "Новикова",
  "Морозов",
  "Лебедев",
  "Соколова",
  "Попова",
];

const EXTRA_HANDLE_STEMS = [
  "marina_kv",
  "stepan_vlk",
  "tais_orl",
  "artem_sm",
  "kamilla_z",
  "den_bel",
  "sofya_grm",
  "nikita_ef",
  "alina_ryb",
  "vlad_shi",
  "maria_sea",
  "pavel_rd",
  "ksenia_ln",
  "olga_mist",
  "igor_wave",
  "natali_sun",
  "sergey_ok",
  "vika_soft",
  "andrey_h",
  "katya_m",
];

/** Имена в чатах и ленте: «Имя Фамилия», как на вкладке «Люди» (те же словари). */
function buildDemoChatDisplayNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 45; i++) {
    if (i === 24) {
      out.push("Команда Flora");
      continue;
    }
    const fn = EXTRA_FIRST[(i + 4) % EXTRA_FIRST.length];
    const ln = EXTRA_LAST[(i * 5 + 1) % EXTRA_LAST.length];
    out.push(`${fn} ${ln}`);
  }
  return out;
}

const DEMO_NAMES: readonly string[] = buildDemoChatDisplayNames();

/** Латинские ники без префикса @ — как в API. */
const DEMO_HANDLES = [
  "anna_moroz",
  "boris_krav",
  "vera_sokol",
  "gleb_taran",
  "daria_lens",
  "egor_plate",
  "zhanna_ryad",
  "zakhar_note",
  "irina_volna",
  "kirill_dof",
  "liza_obl",
  "max_zhuk",
  "nika_est",
  "oleg_yurk",
  "polina_zori",
  "roman_gor",
  "sveta_chern",
  "timur_sh",
  "ulyana_holm",
  "fedor_calm",
  "hana_bridge",
  "elina_yar",
  "yuri_e",
  "yana_yu",
  "flora_team",
  "marina_li",
  "grigory_sokol",
  "mila_krot",
  "timofey_orl",
  "polina_foto",
  "andrey_rul",
  "daria_zhuk",
  "renata_staya",
  "semen_park",
  "inga_volna",
  "marat_gild",
  "vera_grom",
  "daniil_krug",
  "stanislav_pr",
  "tamara_shch",
  "ilyas_yar",
  "anna_barkh",
  "petr_fakt",
  "bogdan_falk",
  "serafima_dr",
];

function peerUuid(i: number): string {
  const hex = (0x100000 + i).toString(16).padStart(12, "0");
  return `00000000-0000-4001-8000-${hex}`;
}

function isoMinutesAgo(m: number): string {
  return new Date(Date.now() - m * 60 * 1000).toISOString();
}

function buildInitialConversations(): ConversationListItemDto[] {
  const theirLines = [
    "Ок, гляну вечером.",
    "Можем в пятницу после шести?",
    "Кинула ссылку в сообщения.",
    "Ты видел последний эпизод?",
    "На выходных как раз будет солнце.",
    "Перешлю голосовое чуть позже.",
    "Спасибо, очень выручил.",
    "У кого-нибудь есть лишний билет?",
    "Завтра заеду за вещами.",
    "Напомни, пожалуйста, адрес.",
  ];
  const myLines = [
    "Скинул фото с прогулки.",
    "Да, давай так и сделаем.",
    "Написал в общий чат.",
    "Можешь глянуть черновик?",
    "Встреча переносится на час.",
  ];
  return DEMO_NAMES.map((displayName, i) => {
    const fromMe = i % 4 === 0;
    return {
      otherUserUuid: peerUuid(i + 1),
      otherUsername: DEMO_HANDLES[i] ?? `friend_${i + 1}`,
      otherDisplayName: displayName,
      lastMessageUuid: `20000000-0000-4000-8000-${(0x200000 + i).toString(16).padStart(12, "0")}`,
      lastMessageContent: fromMe ? myLines[i % myLines.length] : theirLines[i % theirLines.length],
      lastMessageEncryptedForMe: null,
      lastMessageIsFromMe: fromMe,
      hasEncryptedPreview: false,
      lastMessageAt: isoMinutesAgo(i * 7 + 3),
      unreadCount: i % 5 === 0 ? Math.min(1 + (i % 4), 9) : 0,
      otherUserIsOnline: i % 3 !== 0,
      otherUserLastSeenAt: isoMinutesAgo(i * 7 + 3 + 12),
    };
  });
}

let devConversationList: ConversationListItemDto[] = buildInitialConversations();

const devThreads = new Map<string, MessageThreadItemDto[]>();

const THREAD_THEM = [
  "Привет! Как прошли выходные?",
  "Мы как раз собирались в кино — пойдёшь?",
  "Нашла классное кафе недалеко от вокзала.",
  "Передай привет всем дома.",
  "Фотки с прогулки уже в альбоме.",
  "Дождь вроде закончился, можно гулять.",
  "Напиши, когда будешь на месте.",
  "Сегодня очередь в магазине была небольшая.",
  "Забыла спросить: ты ел уже?",
  "У нас всё хорошо, не переживай.",
];

const THREAD_ME = [
  "Привет, всё отлично.",
  "Да, давай созвонимся.",
  "Уже почти дома.",
  "Скину ссылку чуть позже.",
  "Суп, спасибо что спросил.",
  "Ок, подожду у входа.",
  "Передам, обязательно.",
  "Завтра как раз свободен.",
  "Классные кадры, спасибо.",
  "До встречи!",
];

function seedThread(peerUuid: string): MessageThreadItemDto[] {
  const now = Date.now();
  const rows: MessageThreadItemDto[] = [];
  const hex = peerUuid.replace(/-/g, "");
  const mix = Number.parseInt(hex.slice(-8), 16) || 0;
  for (let k = 0; k < 18; k++) {
    const fromMe = k % 3 !== 0;
    const baseLine = fromMe
      ? THREAD_ME[(k + mix) % THREAD_ME.length]
      : THREAD_THEM[(k + mix) % THREAD_THEM.length];
    const line =
      k % 9 === 4
        ? "Голосовое сообщение · 0:12"
        : k % 11 === 6
          ? `${baseLine}\nГолосовое сообщение · 0:08`
          : baseLine;
    rows.push({
      messageUuid: `30000000-0000-4000-8000-${(0x300000 + k * 7919 + (mix % 0xfffff)).toString(16).padStart(12, "0")}`,
      content: line,
      encryptedForMe: null,
      createdAt: new Date(now - (18 - k) * 3600 * 1000).toISOString(),
      isFromMe: fromMe,
    });
  }
  return rows;
}

export function devDemoGetConversations(): ConversationListItemDto[] {
  return devConversationList;
}

export function devDemoGetThread(peerUuid: string): MessageThreadItemDto[] {
  if (!devThreads.has(peerUuid)) {
    devThreads.set(peerUuid, seedThread(peerUuid));
  }
  return devThreads.get(peerUuid)!;
}

/** @deprecated Используйте devDemoAppendOutgoingMessage для блочных сообщений (в т.ч. голосовых). */
export function devDemoAppendOutgoing(peerUuid: string, plain: string): { messageUuid: string; createdAt: string } {
  return devDemoAppendOutgoingMessage(peerUuid, {
    type: "blocks",
    version: 1,
    blocks: [{ kind: "text", body: plain }],
    clientCreatedAt: new Date().toISOString(),
  });
}

export function devDemoAppendOutgoingMessage(
  peerUuid: string,
  payload: FscpMessagePlaintext
): { messageUuid: string; createdAt: string } {
  const messageUuid = floraNewUuid();
  const createdAt = new Date().toISOString();
  const listPreview = demoPayloadListPreview(payload);
  const list = devDemoGetThread(peerUuid);
  list.push({
    messageUuid,
    content: null,
    encryptedForMe: devPlaintextWire(payload),
    createdAt,
    isFromMe: true,
  });
  devConversationList = devConversationList.map((c) =>
    c.otherUserUuid === peerUuid
      ? {
          ...c,
          lastMessageUuid: messageUuid,
          lastMessageContent: listPreview.length > 0 ? listPreview : null,
          lastMessageEncryptedForMe: null,
          lastMessageIsFromMe: true,
          hasEncryptedPreview: false,
          lastMessageAt: createdAt,
        }
      : c
  );
  const hit = devConversationList.find((c) => c.otherUserUuid === peerUuid);
  if (hit) {
    devConversationList = [hit, ...devConversationList.filter((c) => c.otherUserUuid !== peerUuid)];
  }
  return { messageUuid, createdAt };
}

export function devDemoMarkRead(peerUuid: string): void {
  devConversationList = devConversationList.map((c) =>
    c.otherUserUuid === peerUuid ? { ...c, unreadCount: 0 } : c
  );
}

/** Доп. строки для вкладки «Люди» при DEV_LOCAL_RICH_UI. */
export function devDemoPeopleRows(): { id: string; displayName: string; username: string; followers: number }[] {
  return Array.from({ length: 42 }, (_, i) => {
    const fn = EXTRA_FIRST[i % EXTRA_FIRST.length];
    const ln = EXTRA_LAST[(i * 3) % EXTRA_LAST.length];
    const stem = EXTRA_HANDLE_STEMS[i % EXTRA_HANDLE_STEMS.length];
    return {
      id: `rich-person-${i + 1}`,
      displayName: `${fn} ${ln}`,
      username: `@${stem}_${100 + i}`,
      followers: 120 + ((i * 37) % 18000),
    };
  });
}

const NOTIF_SOCIAL = [
  (who: string) => `${who} оценил ваш пост`,
  (who: string) => `${who} ответил в обсуждении`,
  (who: string) => `Новый подписчик: ${who}`,
  (who: string) => `${who} упомянул вас в посте`,
  (who: string) => `${who} пригласил вас в сообщество`,
];

const NOTIF_DEV = [
  () => "Доступно обновление приложения.",
  () => "Резервная копия альбома завершена.",
  () => "Вход с нового устройства — если это не вы, смените пароль.",
  () => "Память почти заполнена: освободите место в облаке.",
  () => "Напоминание: завтра истекает подписка на хранилище.",
];

export function devDemoNotificationsList(): {
  id: string;
  type: string;
  category: "social" | "developer";
  text: string;
  timeAgo: string;
  isUnread: boolean;
}[] {
  const out: {
    id: string;
    type: string;
    category: "social" | "developer";
    text: string;
    timeAgo: string;
    isUnread: boolean;
  }[] = [];
  for (let i = 0; i < 55; i++) {
    const dev = i % 7 === 0;
    const cat: "social" | "developer" = dev ? "developer" : "social";
    const type = dev ? (i % 2 === 0 ? "developer" : "default") : (["like", "reply", "follow"] as const)[i % 3];
    const who = `@${DEMO_HANDLES[i % DEMO_HANDLES.length]}`;
    const text = dev ? NOTIF_DEV[i % NOTIF_DEV.length]() : NOTIF_SOCIAL[i % NOTIF_SOCIAL.length](who);
    out.push({
      id: `rich-notif-${i + 1}`,
      type,
      category: cat,
      text,
      timeAgo:
        i < 8 ? `${(i + 1) * 3} мин назад` : i < 20 ? `${i + 1} ч назад` : i < 40 ? "вчера" : "на прошлой неделе",
      isUnread: i % 4 !== 1,
    });
  }
  return out;
}

const FEED_BODIES = [
  "Наконец дочитала книгу — оставила пару мыслей в конце.",
  "Сегодня город в тумане, как в кино.",
  "Собрала плейлист на дорогу — кину в комментарии.",
  "Ужин получился с первого раза, удивила сама себя.",
  "Кто-нибудь был на новой выставке в центре?",
  "Воскресный рынок снова радует сезоном.",
  "Пересадила фиалки — надеюсь, приживутся.",
  "Нашла старые фото с дачи, так и сидела смотрела.",
  "Планируем поездку на море в конце месяца.",
  "Вчерашний закат был нереальный.",
  "Рецепт торта оказался проще, чем казалось.",
  "Пробежка утром снова вошла в привычку.",
  "Купила билеты на концерт — кто рядом?",
  "Дождь стучит по крыше, уютно.",
  "Поделилась заметками о поездке в блоге.",
  "Дети весь день на улице — редкость для зимы.",
  "Сшила чехол для гитары, горжусь маленькой победой.",
  "В кафе на углу появился новый десерт.",
  "Соседи принесли пирог — добрый вечер получился.",
  "Ночью смотрели на звёзды с балкона.",
  "Перечитала переписку с бабушкой и улыбнулась.",
  "Заказала семена — весна близко.",
  "Попробовал новый маршрут на работу, быстрее на четверть часа.",
  "Мама научила готовить борщ «как у неё».",
  "Собака встретила меня у двери, как всегда.",
  "В парке уже чувствуется весна.",
  "Собрались за столом без повода — лучший повод.",
  "Написал пару строк в дневнике перед сном.",
  "Купил на барахолке пластинку с детства.",
  "Сестра прислала голосовое с моря — завидую белой завистью.",
  "В выходные спали до десяти — заслуженно.",
  "Помог другу переехать, устали, но довольны.",
  "Нашёл в шкафу свитер, который считал потерянным.",
  "Вечером пили чай и спорили о фильмах.",
  "Записался на йогу — посмотрим, выдержу ли.",
  "Старый друг написал из другого города — приятно.",
  "На кухне пахнет яблоками и корицей.",
  "Прогулка с коляской по набережной — классика.",
  "Сделал уборку и сразу легче на душе.",
  "Заказал цветы маме без повода.",
  "В метро услышал уличного музыканта — остановился послушать.",
  "Пересмотрел любимый сериал с начала.",
  "Соседка одолжила лестницу — починил люстру.",
  "В воскресенье готовили пельмени всей семьёй.",
  "Нашёл в кармане жетон метро — знак.",
  "Вечером только музыка и тишина.",
];

const DEV_FEED_REFRESH_WINDOW = 5;
const DEV_FEED_REFRESH_PROBS = [1.0, 0.75, 0.55, 0.35, 0.15] as const;

let devDemoFeedPreviousTop: string[] = [];

function buildDevDemoFeedPosts(n: number): FeedPostDto[] {
  const communities = ["Flora Design", "Утренний эспрессо", "Плёс и палатка", null] as const;
  return Array.from({ length: n }, (_, i) => ({
    postUuid: `0000feed-0000-4000-8000-${(0xe00000 + i).toString(16).padStart(12, "0")}`,
    content: FEED_BODIES[i % FEED_BODIES.length],
    createdAt: new Date(Date.now() - i * 3700000).toISOString(),
    authorUsername: DEMO_HANDLES[(i * 5) % DEMO_HANDLES.length],
    authorDisplayName: DEMO_NAMES[(i * 5) % DEMO_NAMES.length],
    communityName: communities[i % communities.length],
    communitySlug: communities[i % communities.length] ? `demo-community-${i % 3}` : null,
    commentsCount: i % 24,
    likesCount: 3 + ((i * 17) % 800),
    repostsCount: i % 11,
    viewsCount: 200 + i * 73,
    liked: false,
    reposted: false,
    imageUuids: [],
  }));
}

function applyDevFeedRefreshShuffle(items: FeedPostDto[], previousTop: string[]): FeedPostDto[] {
  const list = items.slice();
  const window = Math.min(DEV_FEED_REFRESH_WINDOW, list.length);
  if (window === 0 || previousTop.length === 0) return list;

  for (let i = 0; i < window; i++) {
    const p = i < DEV_FEED_REFRESH_PROBS.length ? DEV_FEED_REFRESH_PROBS[i] : 0;
    if (i > 0 && Math.random() >= p) continue;

    const prevId = previousTop[i];
    if (!prevId || list[i]?.postUuid !== prevId) continue;

    const candidateIndex = list.findIndex((post, idx) => idx > i && post.postUuid !== prevId);
    if (candidateIndex < 0) continue;

    const tmp = list[i];
    list[i] = list[candidateIndex];
    list[candidateIndex] = tmp;
  }

  return list;
}

/** Лента для офлайн-сессии (`apiGetFeed`). */
export function devDemoFeedPosts(take: number, options?: { refresh?: boolean }): FeedPostDto[] {
  const n = Math.min(Math.max(take, 1), 45);
  const base = buildDevDemoFeedPosts(n);

  if (!options?.refresh) {
    devDemoFeedPreviousTop = base.slice(0, DEV_FEED_REFRESH_WINDOW).map((p) => p.postUuid);
    return base;
  }

  const shuffled = applyDevFeedRefreshShuffle(base, devDemoFeedPreviousTop);
  devDemoFeedPreviousTop = shuffled.slice(0, DEV_FEED_REFRESH_WINDOW).map((p) => p.postUuid);
  return shuffled;
}

/** Узкая лента «только подписки» для офлайн-сессии — отличается от рекомендаций. */
export function devDemoFeedSubscriptions(take: number): FeedPostDto[] {
  const n = Math.min(Math.max(take, 1), 45);
  const followed = new Set(["anna_moroz", "boris_krav", "vera_sokol"]);
  return devDemoFeedPosts(120)
    .filter((p) => followed.has(p.authorUsername))
    .slice(0, n);
}

const DEMO_COMMENT_BODIES = [
  "Согласен, особенно про вторую мысль.",
  "У нас в команде обсуждали то же самое на прошлой неделе.",
  "Классно расписано, сохранил в закладки.",
  "Интересная точка зрения — не думал с этой стороны.",
  "Поддерживаю. Ещё бы добавил про дедлайны.",
  "Спасибо, как раз искал именно это.",
  "Скрин в избранное, пригодится.",
  "У нас похожий кейс — сработало.",
  "Согласна на все сто процентов.",
  "Жду продолжения темы.",
];

/** Комментарии к посту для офлайн-сессии (`apiGetPostComments`). */
const DEMO_PROFILE_STATUSES = [
  "На связи",
  "В дороге",
  "Слушаю музыку",
  "На прогулке",
  "Работаю над проектом",
  "Недоступен",
  "Читаю",
  "Пью кофе",
] as const;

function normDemoUsername(username: string): string {
  return username.trim().replace(/^@+/, "").toLowerCase();
}

function hashDemoSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 33 + slug.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function peopleBaseUuid(id: string): string {
  const hex = Array.from(id)
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0)
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  return `0000people-0000-4000-8000-${hex}`;
}

function richPersonUuid(index: number): string {
  return `0000richpe-0000-4000-8000-${(0x100000 + index).toString(16).padStart(12, "0")}`;
}

function buildDemoProfileRegistry(): Map<string, PublicProfileDto> {
  const map = new Map<string, PublicProfileDto>();

  const add = (profile: PublicProfileDto) => {
    const slug = normDemoUsername(profile.username);
    if (!slug) return;
    map.set(slug, profile);
  };

  add({
    userUuid: DEV_LOCAL_ME.userUuid,
    username: DEV_LOCAL_ME.username,
    displayName: DEV_LOCAL_ME.displayName,
    status: DEV_LOCAL_ME.status ?? "",
    followersCount: DEV_LOCAL_ME.followersCount ?? 0,
    followingCount: DEV_LOCAL_ME.followingCount ?? 0,
    isFollowingByMe: false,
  });

  for (const person of DEV_DEMO_PEOPLE_BASE) {
    const slug = normDemoUsername(person.username);
    const h = hashDemoSlug(slug);
    add({
      userUuid: peopleBaseUuid(person.id),
      username: slug,
      displayName: person.displayName,
      status: DEMO_PROFILE_STATUSES[h % DEMO_PROFILE_STATUSES.length],
      followersCount: person.followers,
      followingCount: Math.max(12, Math.floor(person.followers * 0.18)),
      isFollowingByMe: false,
    });
  }

  for (let i = 0; i < DEMO_HANDLES.length; i++) {
    const username = DEMO_HANDLES[i] ?? `friend_${i + 1}`;
    const slug = normDemoUsername(username);
    add({
      userUuid: peerUuid(i + 1),
      username: slug,
      displayName: DEMO_NAMES[i] ?? "Пользователь",
      status: DEMO_PROFILE_STATUSES[(i + 2) % DEMO_PROFILE_STATUSES.length],
      followersCount: 180 + ((i * 41) % 4200),
      followingCount: 40 + ((i * 17) % 380),
      isFollowingByMe: false,
    });
  }

  for (const row of devDemoPeopleRows()) {
    const slug = normDemoUsername(row.username);
    const match = /^rich-person-(\d+)$/.exec(row.id);
    const idx = match ? Number.parseInt(match[1], 10) : 0;
    add({
      userUuid: richPersonUuid(idx),
      username: slug,
      displayName: row.displayName,
      status: DEMO_PROFILE_STATUSES[(idx + 4) % DEMO_PROFILE_STATUSES.length],
      followersCount: row.followers,
      followingCount: Math.max(8, Math.floor(row.followers * 0.14)),
      isFollowingByMe: false,
    });
  }

  return map;
}

let demoProfileRegistry: Map<string, PublicProfileDto> | null = null;

function getDemoProfileRegistry(): Map<string, PublicProfileDto> {
  if (!demoProfileRegistry) demoProfileRegistry = buildDemoProfileRegistry();
  return demoProfileRegistry;
}

/** Публичный профиль для офлайн-сессии (`apiGetPublicProfile`). */
export function devDemoGetPublicProfile(username: string): PublicProfileDto | null {
  const slug = normDemoUsername(username);
  if (!slug) return null;
  return getDemoProfileRegistry().get(slug) ?? null;
}

function feedPostToProfilePost(post: FeedPostDto): ProfilePostDto {
  return {
    postUuid: post.postUuid,
    content: post.content,
    createdAt: post.createdAt,
    commentsCount: post.commentsCount,
    likesCount: post.likesCount,
    repostsCount: post.repostsCount,
    viewsCount: post.viewsCount,
    liked: post.liked,
    reposted: post.reposted,
    imageUuids: post.imageUuids,
  };
}

function generateWallPostsForSlug(slug: string, count: number): ProfilePostDto[] {
  const h = hashDemoSlug(slug);
  return Array.from({ length: count }, (_, i) => ({
    postUuid: `0000wall-${h.toString(16).padStart(8, "0")}-4000-8000-${((h + i * 97) & 0xfffffff).toString(16).padStart(12, "0")}`,
    content: FEED_BODIES[(h + i) % FEED_BODIES.length],
    createdAt: new Date(Date.now() - (i + 1) * 5 * 3600000).toISOString(),
    commentsCount: (h + i) % 15,
    likesCount: 5 + ((h + i * 17) % 200),
    repostsCount: (h + i) % 8,
    viewsCount: 80 + i * 41,
    liked: false,
    reposted: false,
    imageUuids: [],
  }));
}

/** Стена профиля для офлайн-сессии (`apiGetProfilePosts`). */
export function devDemoGetProfilePosts(username: string, skip = 0, take = 20): ProfilePostDto[] {
  const slug = normDemoUsername(username);
  if (!slug) return [];
  const fromFeed = devDemoFeedPosts(300)
    .filter((post) => normDemoUsername(post.authorUsername) === slug)
    .map(feedPostToProfilePost);
  const wall = fromFeed.length > 0 ? fromFeed : generateWallPostsForSlug(slug, 10);
  const start = Math.max(0, skip);
  return wall.slice(start, start + Math.max(take, 0));
}

export function devDemoPostComments(postUuid: string): PostCommentDto[] {
  let h = 0;
  for (let i = 0; i < postUuid.length; i++) h = (h * 33 + postUuid.charCodeAt(i)) | 0;
  const count = 2 + (Math.abs(h) % 5);
  const out: PostCommentDto[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (Math.abs(h) + i * 7) % DEMO_HANDLES.length;
    const idSuffix = ((Math.abs(h) + i * 13) & 0xfffffff).toString(16).padStart(11, "0");
    const nReplies = (i + Math.abs(h)) % 5;
    const replies: PostCommentDto[] = [];
    for (let j = 0; j < nReplies; j++) {
      const rIdx = (idx + j + 3) % DEMO_HANDLES.length;
      const rSuffix = (((Math.abs(h) + i) << 4) + j * 17) & 0xfffffff;
      const rId = rSuffix.toString(16).padStart(11, "0");
      replies.push({
        commentUuid: `0000reply-0000-4000-8000-${rId}`,
        authorUsername: DEMO_HANDLES[rIdx] ?? "user",
        authorDisplayName: DEMO_NAMES[rIdx] ?? "Пользователь",
        content: DEMO_COMMENT_BODIES[(Math.abs(h) + i + j + 1) % DEMO_COMMENT_BODIES.length],
        createdAt: new Date(Date.now() - (i + 1) * 720000 - j * 3600000 - (Math.abs(h) % 60000)).toISOString(),
        repliesCount: 0,
        replies: [],
      });
    }
    out.push({
      commentUuid: `0000comm-0000-4000-8000-${idSuffix}`,
      authorUsername: DEMO_HANDLES[idx] ?? "user",
      authorDisplayName: DEMO_NAMES[idx] ?? "Пользователь",
      content: DEMO_COMMENT_BODIES[(Math.abs(h) + i) % DEMO_COMMENT_BODIES.length],
      createdAt: new Date(Date.now() - (i + 1) * 720000 - (Math.abs(h) % 60000)).toISOString(),
      repliesCount: nReplies,
      replies,
    });
  }
  return out;
}
