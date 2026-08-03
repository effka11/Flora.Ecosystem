import { floraNewUuid } from "@/lib/floraUuid";
import {
  GROUP_CHAT_MAX_MEMBERS,
  type GroupChat,
  type GroupMember,
  type GroupThreadMessage,
} from "./groupConversationTypes";

const SEED_MEMBERS = {
  anna: {
    userUuid: "a1111111-1111-4111-8111-111111111111",
    username: "anna",
    displayName: "Анна",
  },
  boris: {
    userUuid: "b2222222-2222-4222-8222-222222222222",
    username: "boris",
    displayName: "Борис",
  },
  vera: {
    userUuid: "c3333333-3333-4333-8333-333333333333",
    username: "vera",
    displayName: "Вера",
  },
  dmitry: {
    userUuid: "d4444444-4444-4444-8444-444444444444",
    username: "dmitry",
    displayName: "Дмитрий",
  },
  elena: {
    userUuid: "e5555555-5555-4555-8555-555555555555",
    username: "elena",
    displayName: "Елена",
  },
} as const satisfies Record<string, GroupMember>;

const SEED_GROUP_DESIGN_UUID = "f1000000-0000-4000-8000-000000000001";
const SEED_GROUP_HIKE_UUID = "f1000000-0000-4000-8000-000000000002";

type StoreState = {
  groups: GroupChat[];
  threads: Map<string, GroupThreadMessage[]>;
  /** Last viewer uuid injected into seed/group rosters (mock). */
  viewerUserUuid: string | null;
};

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function buildSeedState(): StoreState {
  const designMembers: GroupMember[] = [
    SEED_MEMBERS.anna,
    SEED_MEMBERS.boris,
    SEED_MEMBERS.vera,
  ];
  const hikeMembers: GroupMember[] = [
    SEED_MEMBERS.dmitry,
    SEED_MEMBERS.elena,
    SEED_MEMBERS.anna,
  ];

  const designThread: GroupThreadMessage[] = [
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_DESIGN_UUID,
      senderUserUuid: SEED_MEMBERS.anna.userUuid,
      body: "Собрала референсы по сетке — гляньте папку.",
      createdAt: isoMinutesAgo(120),
    },
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_DESIGN_UUID,
      senderUserUuid: SEED_MEMBERS.boris.userUuid,
      body: "Ок, вечером пройдусь по compose.",
      createdAt: isoMinutesAgo(95),
    },
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_DESIGN_UUID,
      senderUserUuid: SEED_MEMBERS.vera.userUuid,
      body: "И аватар группы пока заглушкой — нормально для mock.",
      createdAt: isoMinutesAgo(40),
    },
  ];

  const hikeThread: GroupThreadMessage[] = [
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_HIKE_UUID,
      senderUserUuid: SEED_MEMBERS.dmitry.userUuid,
      body: "Выходим в субботу в 8:00 от метро.",
      createdAt: isoMinutesAgo(200),
    },
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_HIKE_UUID,
      senderUserUuid: SEED_MEMBERS.elena.userUuid,
      body: "Беру термос и аптечку.",
      createdAt: isoMinutesAgo(180),
    },
    {
      messageUuid: floraNewUuid(),
      conversationUuid: SEED_GROUP_HIKE_UUID,
      senderUserUuid: SEED_MEMBERS.anna.userUuid,
      body: "Погода обещают +12, куртки не забудьте.",
      createdAt: isoMinutesAgo(15),
    },
  ];

  const lastDesign = designThread[designThread.length - 1]!;
  const lastHike = hikeThread[hikeThread.length - 1]!;

  return {
    viewerUserUuid: null,
    groups: [
      {
        conversationUuid: SEED_GROUP_DESIGN_UUID,
        title: "Дизайн Flora",
        members: designMembers,
        lastMessagePreview: lastDesign.body,
        lastMessageAt: lastDesign.createdAt,
        unreadCount: 2,
        createdAt: isoMinutesAgo(60 * 24 * 7),
      },
      {
        conversationUuid: SEED_GROUP_HIKE_UUID,
        title: "Поход",
        members: hikeMembers,
        lastMessagePreview: lastHike.body,
        lastMessageAt: lastHike.createdAt,
        unreadCount: 0,
        createdAt: isoMinutesAgo(60 * 24 * 3),
      },
    ],
    threads: new Map([
      [SEED_GROUP_DESIGN_UUID, designThread],
      [SEED_GROUP_HIKE_UUID, hikeThread],
    ]),
  };
}

let state: StoreState = buildSeedState();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function cloneGroup(group: GroupChat): GroupChat {
  return {
    ...group,
    members: group.members.map((m) => ({ ...m })),
  };
}

function withMemberFirst(members: readonly GroupMember[], viewer: GroupMember): GroupMember[] {
  const rest = members.filter((m) => m.userUuid !== viewer.userUuid);
  return [{ ...viewer }, ...rest.map((m) => ({ ...m }))];
}

export function subscribeMockGroupStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listMockGroupChats(): GroupChat[] {
  return state.groups.map(cloneGroup);
}

export function getMockGroupChat(conversationUuid: string): GroupChat | null {
  const found = state.groups.find((g) => g.conversationUuid === conversationUuid);
  return found ? cloneGroup(found) : null;
}

export function getMockGroupThread(conversationUuid: string): GroupThreadMessage[] {
  const thread = state.threads.get(conversationUuid) ?? [];
  return thread.map((m) => ({ ...m }));
}

/**
 * Ensure the signed-in viewer is on every mock group roster (seed + created).
 * Idempotent per viewer uuid; replaces previous injected viewer if the account changes.
 */
export function ensureMockGroupViewer(viewer: GroupMember): void {
  const uuid = viewer.userUuid.trim();
  if (!uuid) return;
  if (state.viewerUserUuid === uuid) {
    const alreadyEverywhere = state.groups.every((g) =>
      g.members.some((m) => m.userUuid === uuid),
    );
    if (alreadyEverywhere) return;
  }

  const prevViewer = state.viewerUserUuid;
  const nextGroups = state.groups.map((g) => {
    let members = g.members;
    if (prevViewer && prevViewer !== uuid) {
      members = members.filter((m) => m.userUuid !== prevViewer);
    }
    return { ...g, members: withMemberFirst(members, viewer) };
  });

  state = { ...state, groups: nextGroups, viewerUserUuid: uuid };
  emit();
}

export function createMockGroupChat(params: {
  title: string;
  creator: GroupMember;
  members: readonly GroupMember[];
}): GroupChat {
  const byUuid = new Map<string, GroupMember>();
  byUuid.set(params.creator.userUuid, { ...params.creator });
  for (const member of params.members) {
    byUuid.set(member.userUuid, { ...member });
  }
  const members = [...byUuid.values()];
  if (members.length < 2) {
    throw new Error("Group needs at least one member besides the creator.");
  }
  if (members.length > GROUP_CHAT_MAX_MEMBERS) {
    throw new Error(`Group may have at most ${GROUP_CHAT_MAX_MEMBERS} members.`);
  }

  const conversationUuid = floraNewUuid();
  const createdAt = new Date().toISOString();
  const title = params.title.trim() || "Группа";
  const group: GroupChat = {
    conversationUuid,
    title,
    members: withMemberFirst(members, params.creator),
    lastMessagePreview: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt,
  };
  state = {
    ...state,
    viewerUserUuid: params.creator.userUuid,
    groups: [group, ...state.groups],
    threads: new Map(state.threads).set(conversationUuid, []),
  };
  emit();
  return cloneGroup(group);
}

export function appendMockGroupPlaintext(params: {
  conversationUuid: string;
  sender: GroupMember;
  body: string;
}): GroupThreadMessage | null {
  const text = params.body.trim();
  if (!text) return null;
  const groupIndex = state.groups.findIndex(
    (g) => g.conversationUuid === params.conversationUuid,
  );
  if (groupIndex < 0) return null;

  const createdAt = new Date().toISOString();
  const message: GroupThreadMessage = {
    messageUuid: floraNewUuid(),
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.sender.userUuid,
    body: text,
    createdAt,
  };

  const nextThreads = new Map(state.threads);
  const prev = nextThreads.get(params.conversationUuid) ?? [];
  nextThreads.set(params.conversationUuid, [...prev, message]);

  const nextGroups = state.groups.map((g, i) =>
    i === groupIndex
      ? {
          ...g,
          lastMessagePreview: text,
          lastMessageAt: createdAt,
          unreadCount: 0,
        }
      : g,
  );

  state = { ...state, groups: nextGroups, threads: nextThreads };
  emit();
  return { ...message };
}

export function markMockGroupRead(conversationUuid: string): void {
  let changed = false;
  const nextGroups = state.groups.map((g) => {
    if (g.conversationUuid !== conversationUuid || g.unreadCount === 0) return g;
    changed = true;
    return { ...g, unreadCount: 0 };
  });
  if (!changed) return;
  state = { ...state, groups: nextGroups };
  emit();
}

/** Test helper — resets seed fixtures. */
export function resetMockGroupStoreForTests(): void {
  state = buildSeedState();
  emit();
}
