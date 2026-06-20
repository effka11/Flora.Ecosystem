export function probeAudioDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();

    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    };

    audio.preload = "metadata";
    audio.addEventListener(
      "loadedmetadata",
      () => {
        const seconds = audio.duration;
        cleanup();
        if (!Number.isFinite(seconds) || seconds <= 0) {
          reject(new Error("Не удалось определить длительность трека."));
          return;
        }
        resolve(Math.max(1, Math.round(seconds * 1000)));
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("Не удалось прочитать аудиофайл."));
      },
      { once: true },
    );

    audio.src = url;
  });
}
