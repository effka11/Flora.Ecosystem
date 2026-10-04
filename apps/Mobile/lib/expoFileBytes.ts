import { File } from "expo-file-system";

type ExpoNativeFile = File & {
  bytes?: () => Promise<Uint8Array>;
  bytesSync?: () => Uint8Array;
  write?: (content: string | Uint8Array) => void;
};

export async function readExpoFileBytes(file: File): Promise<Uint8Array> {
  const native = file as ExpoNativeFile;
  if (typeof native.bytes === "function") {
    return native.bytes();
  }
  if (typeof native.bytesSync === "function") {
    return native.bytesSync();
  }
  return new Uint8Array(await file.arrayBuffer());
}

export function writeExpoFileBytes(file: File, content: Uint8Array): void {
  const native = file as ExpoNativeFile;
  if (typeof native.write !== "function") {
    throw new Error("Запись файла недоступна в этой сборке.");
  }
  native.write(content);
}

export function assertExpoFileUpload(file: File): void {
  if (typeof file.upload !== "function") {
    throw new Error("Загрузка файла недоступна в этой сборке.");
  }
}
