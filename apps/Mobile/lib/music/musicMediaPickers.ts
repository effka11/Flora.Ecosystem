import { Alert } from "react-native";

import type { PickedMusicFile } from "@/lib/music/musicUpload";

const NATIVE_REBUILD_HINT =
  "Выбор файлов доступен после пересборки dev build (expo run:android) с expo-document-picker.";

type PickerAsset = {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  fileSize?: number | null;
  type?: string | null;
};

function pickedAssetToFile(asset: PickerAsset): PickedMusicFile {
  return {
    uri: asset.uri,
    name: asset.name || asset.uri.split("/").pop() || "file",
    mimeType: asset.mimeType ?? (asset.type ? `image/${asset.type}` : null),
    size: asset.size ?? asset.fileSize ?? null,
  };
}

function isMissingNativeModuleError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Cannot find native module") || message.includes("ExpoDocumentPicker");
}

function showNativePickerUnavailable(): void {
  Alert.alert("Выбор файла", NATIVE_REBUILD_HINT);
}

export async function pickMusicAudioFile(): Promise<PickedMusicFile | null> {
  try {
    const DocumentPicker = await import("expo-document-picker");
    const result = await DocumentPicker.getDocumentAsync({
      type: ["audio/*", "video/mp4"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets[0]) return null;
    return pickedAssetToFile(result.assets[0]);
  } catch (err) {
    if (isMissingNativeModuleError(err)) {
      showNativePickerUnavailable();
      return null;
    }
    throw err;
  }
}

export async function pickMusicCoverFile(): Promise<PickedMusicFile | null> {
  try {
    const ImagePicker = await import("expo-image-picker");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return null;
    return pickedAssetToFile(result.assets[0]);
  } catch (err) {
    if (isMissingNativeModuleError(err)) {
      showNativePickerUnavailable();
      return null;
    }
    throw err;
  }
}
