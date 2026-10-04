/** Own-profile header: session `/me` first, public profile as fallback (Web parity). */
export function resolveOwnProfileAvatarUuid(
  meAvatarUuid?: string | null,
  publicAvatarUuid?: string | null,
): string | null {
  const fromMe = meAvatarUuid?.trim() ?? "";
  if (fromMe) return fromMe;
  const fromPublic = publicAvatarUuid?.trim() ?? "";
  return fromPublic || null;
}
