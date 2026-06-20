import type sodiumType from "libsodium-wrappers";

let sodiumRef: typeof sodiumType | null = null;

export async function getSodium(): Promise<typeof sodiumType> {
  if (sodiumRef) return sodiumRef;
  const mod = await import("libsodium-wrappers");
  await mod.default.ready;
  sodiumRef = mod.default;
  return sodiumRef;
}
