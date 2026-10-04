import { COMPOSE_NEUTRAL_BODY_TTL_MS } from "./composeNeutralCache";

const DB_NAME = "flora-compose";
const DB_VERSION = 1;
const STORE = "draftImages";

type StoredComposeImage = {
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
};

type ImageStoreEntry = {
  images: StoredComposeImage[];
  savedAt: number;
};

function neutralImagesKey(scopeKey: string): string {
  return `neutral:${scopeKey}`;
}

function draftImagesKey(draftUuid: string): string {
  return `draft:${draftUuid}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readEntry(key: string): Promise<ImageStoreEntry | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise<ImageStoreEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
      req.onsuccess = () => {
        const value = req.result;
        if (
          !value ||
          typeof value !== "object" ||
          !("images" in value) ||
          !Array.isArray((value as ImageStoreEntry).images)
        ) {
          resolve(null);
          return;
        }
        resolve(value as ImageStoreEntry);
      };
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function writeEntry(key: string, entry: ImageStoreEntry): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put(entry, key);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB write failed"));
      req.onsuccess = () => resolve();
      tx.oncomplete = () => db.close();
    });
  } catch {
    /* quota / private mode */
  }
}

async function deleteEntry(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).delete(key);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
      req.onsuccess = () => resolve();
      tx.oncomplete = () => db.close();
    });
  } catch {
    /* quota / private mode */
  }
}

async function filesToStored(files: File[]): Promise<StoredComposeImage[]> {
  const out: StoredComposeImage[] = [];
  for (const file of files) {
    out.push({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      data: await file.arrayBuffer(),
    });
  }
  return out;
}

function storedToFiles(stored: StoredComposeImage[]): File[] {
  return stored.map(
    (item) =>
      new File([item.data], item.name, {
        type: item.type,
        lastModified: item.lastModified,
      }),
  );
}

export function fingerprintComposeImages(files: File[]): string {
  if (files.length === 0) return "";
  return files.map((f) => `${f.name}:${f.lastModified}:${f.size}`).join("|");
}

export async function readComposeNeutralImages(scopeKey: string): Promise<File[]> {
  const entry = await readEntry(neutralImagesKey(scopeKey));
  if (!entry) return [];
  if (Date.now() - entry.savedAt >= COMPOSE_NEUTRAL_BODY_TTL_MS) {
    await deleteEntry(neutralImagesKey(scopeKey));
    return [];
  }
  return storedToFiles(entry.images);
}

export async function writeComposeNeutralImages(scopeKey: string, files: File[]): Promise<void> {
  const key = neutralImagesKey(scopeKey);
  if (files.length === 0) {
    await deleteEntry(key);
    return;
  }
  await writeEntry(key, { images: await filesToStored(files), savedAt: Date.now() });
}

export async function clearComposeNeutralImages(scopeKey: string): Promise<void> {
  await deleteEntry(neutralImagesKey(scopeKey));
}

export async function readComposeDraftImages(draftUuid: string): Promise<File[]> {
  const entry = await readEntry(draftImagesKey(draftUuid));
  if (!entry) return [];
  return storedToFiles(entry.images);
}

export async function writeComposeDraftImages(draftUuid: string, files: File[]): Promise<void> {
  const key = draftImagesKey(draftUuid);
  if (files.length === 0) {
    await deleteEntry(key);
    return;
  }
  await writeEntry(key, { images: await filesToStored(files), savedAt: Date.now() });
}

export async function clearComposeDraftImages(draftUuid: string): Promise<void> {
  await deleteEntry(draftImagesKey(draftUuid));
}

export async function moveComposeNeutralImagesToDraft(scopeKey: string, draftUuid: string): Promise<void> {
  const files = await readComposeNeutralImages(scopeKey);
  if (files.length > 0) {
    await writeComposeDraftImages(draftUuid, files);
  }
  await clearComposeNeutralImages(scopeKey);
}
