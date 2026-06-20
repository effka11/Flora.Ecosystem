import { DEV_LOCAL_RICH_UI } from "@/lib/devLocalDemoFlags";

export type CommunityTab = "recommendations" | "subscriptions" | "owned";

export type CommunityPost = {
  id: string;
  text: string;
  likes: number;
  comments: number;
  reposts: number;
  views: number;
  time: string;
};

export type CommunityRecord = {
  id: string;
  /** Человекочитаемый сегмент URL (`/communities/<slug>`). */
  slug?: string;
  name: string;
  members: number;
  tab: CommunityTab;
  description: string;
  posts: CommunityPost[];
};

export type CommunityLinkTarget = Pick<CommunityRecord, "id" | "slug">;

const demoPosts = (prefix: string): CommunityPost[] => [
  {
    id: `${prefix}-p1`,
    text: "Новости недели, планы на выходные и пара фото с прогулки.",
    likes: 132,
    comments: 18,
    reposts: 7,
    views: 1204,
    time: "2 ч",
  },
  {
    id: `${prefix}-p2`,
    text: "Собрались в субботу на настолки — кто ещё в деле, отметьтесь в комментариях.",
    likes: 67,
    comments: 5,
    reposts: 2,
    views: 488,
    time: "5 ч",
  },
];

const BASE_COMMUNITIES: CommunityRecord[] = [
  {
    id: "1",
    name: "Flora Design",
    members: 1234,
    tab: "recommendations",
    description: "Сообщество про визуальную систему FLORA и сеточную вёрстку интерфейсов.",
    posts: demoPosts("1"),
  },
  {
    id: "2",
    name: "Luna Tech",
    members: 582,
    tab: "recommendations",
    description: "Технологии и продукты в экосистеме Luna.",
    posts: demoPosts("2"),
  },
  {
    id: "3",
    name: "Nature Lab",
    members: 743,
    tab: "subscriptions",
    description: "Исследования и практики устойчивых интерфейсов.",
    posts: demoPosts("3"),
  },
  {
    id: "4",
    name: "Ecosystem Hub",
    members: 912,
    tab: "subscriptions",
    description: "Новости продуктов, встречи с командой и обсуждения без суеты.",
    posts: demoPosts("4"),
  },
];

/** Только для dev offline demo (NEXT_PUBLIC_DEV_AUTO_AUTH=1), не путать с API. */
const DEMO_OWNED_COMMUNITY: CommunityRecord = {
  id: "5",
  name: "Моё сообщество",
  members: 48,
  tab: "owned",
  description: "Небольшое сообщество по интересам: встречи, фото и планы на выходные.",
  posts: demoPosts("5"),
};

function buildRichUiCommunities(): CommunityRecord[] {
  const tabs: CommunityTab[] = ["recommendations", "recommendations", "subscriptions", "owned"];
  const names = [
    "Утренний эспрессо",
    "Плёс и палатка",
    "Плёнка и город",
    "Бег по набережной",
    "Книжный шкаф",
    "Сад на подоконнике",
    "Джаз по вечерам",
    "Родительский уголок",
    "Веломаршруты выходного дня",
    "Кулинарные эксперименты",
    "Путешествия без турагентств",
    "Йога и чай",
    "Ремонт своими руками",
    "Фотопрогулки",
    "Музыка в наушниках",
    "Театральная афиша",
    "Настольные игры",
    "Городские парки",
    "Рукоделие и подарки",
    "Кино после работы",
    "Домашние растения",
    "Соседский двор",
    "Море зимой",
    "Горы летом",
    "Архитектура рядом",
    "Уличная еда",
    "Кофе с собой",
    "Спокойные выходные",
    "Детские площадки",
    "Музеи без очередей",
    "Закаты и рассветы",
    "Семейные рецепты",
    "Походы на природу",
    "Город на велосипеде",
    "Чтение перед сном",
    "Музыка для дороги",
    "Тихие кафе",
  ];
  const snippets = [
    "Кто-нибудь знает хорошую пекарню рядом с парком?",
    "Воскресенье планируем пикник — берите пледы.",
    "Поделилась маршрутом прогулки, гляньте в закрепе.",
    "Нашла уютное место с видом на воду.",
    "Сегодня вечером пробую новый рецепт пирога.",
    "Снимки с прогулки — в альбоме, заходите.",
    "Кто пойдёт на концерт в пятницу?",
    "Собрала подборку плейлистов под дождь.",
    "Напоминание: завтра встреча у фонтана в семь.",
    "Спасибо всем за советы по маршруту!",
  ];
  const descs = [
    "Встречи, советы и спокойные разговоры.",
    "Делимся находками и приглашаем на прогулки.",
    "Здесь про уют, еду и маленькие радости.",
    "Собираем идеи на выходные и праздники.",
    "Поддержка, юмор и полезные ссылки.",
    "Фото, маршруты и хорошие места рядом с домом.",
  ];
  const out: CommunityRecord[] = [];
  for (let i = 0; i < 36; i++) {
    const tab = tabs[i % tabs.length];
    const name = names[i % names.length];
    const desc = descs[i % descs.length];
    const s1 = snippets[i % snippets.length];
    const s2 = snippets[(i + 4) % snippets.length];
    out.push({
      id: `rich-com-${i + 100}`,
    name: name,
      members: 200 + ((i * 133) % 50000),
      tab,
      description: desc,
      posts: [
        {
          id: `rich-com-${i + 100}-p1`,
          text: s1,
          likes: 10 + (i % 200),
          comments: 2 + (i % 40),
          reposts: (i % 12) + 1,
          views: 500 + i * 111,
          time: `${(i % 20) + 1} ч`,
        },
        {
          id: `rich-com-${i + 100}-p2`,
          text: s2,
          likes: 4 + (i % 80),
          comments: (i % 8) + 1,
          reposts: i % 5,
          views: 200 + i * 77,
          time: "вчера",
        },
      ],
    });
  }
  return out;
}

/** Только офлайн-демо; в обычном режиме списки — из API. */
export const COMMUNITIES: CommunityRecord[] = DEV_LOCAL_RICH_UI
  ? [...BASE_COMMUNITIES, DEMO_OWNED_COMMUNITY, ...buildRichUiCommunities()]
  : [];

export const DEMO_OWNED_COMMUNITY_ID = "5";

export function getCommunityById(id: string): CommunityRecord | undefined {
  return COMMUNITIES.find((c) => c.id === id);
}

export function getOwnedCommunity(): CommunityRecord | undefined {
  return getCommunityById(DEMO_OWNED_COMMUNITY_ID);
}

export function isOwnedCommunityId(id: string): boolean {
  return id === DEMO_OWNED_COMMUNITY_ID;
}

export function communityHref(community: CommunityLinkTarget): string {
  if (isOwnedCommunityId(community.id)) return "/communities/own";
  const slug = community.slug?.trim();
  if (slug) return `/communities/${encodeURIComponent(slug)}`;
  return `/communities/${encodeURIComponent(community.id)}`;
}

export function communitySettingsHref(community: CommunityLinkTarget, section?: string): string {
  const base = `${communityHref(community)}/settings`;
  if (section?.trim()) return `${base}?section=${encodeURIComponent(section.trim())}`;
  return base;
}
