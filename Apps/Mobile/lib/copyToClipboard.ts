/** Lazy-load: expo-clipboard требует нативный модуль в dev-client после установки пакета. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
