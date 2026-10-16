/** Макс. длина текста поста и черновика — синхронно с Flora.Content / ImportedSocialController. */
export const MAX_POST_CONTENT_LENGTH = 5000;

export function clampPostContent(text: string): string {
  if (text.length <= MAX_POST_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_POST_CONTENT_LENGTH);
}
