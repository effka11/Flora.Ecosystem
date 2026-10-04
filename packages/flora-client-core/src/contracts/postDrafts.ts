import { asRecord, readStr, type ParseContext } from "./parse.js";

export type PostDraftDto = {
  draftUuid: string;
  label: string;
  content: string;
  communityId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parsePostDraft(raw: unknown, ctx?: ParseContext): PostDraftDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const draftUuid = readStr(o, ["draftUuid", "DraftUuid"], fb);
  if (!draftUuid) return null;
  const communityIdRaw = readStr(o, ["communityId", "CommunityId"], fb);
  return {
    draftUuid,
    label: readStr(o, ["label", "Label"], fb),
    content: readStr(o, ["content", "Content"], fb),
    communityId: communityIdRaw || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    updatedAt: readStr(o, ["updatedAt", "UpdatedAt"], fb),
  };
}

export function parsePostDraftsList(raw: unknown, ctx?: ParseContext): PostDraftDto[] {
  if (!Array.isArray(raw)) return [];
  const out: PostDraftDto[] = [];
  for (const item of raw) {
    const parsed = parsePostDraft(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}
