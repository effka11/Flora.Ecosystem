import { requireOptionalNativeModule } from "expo-modules-core";

type FloraFrcINativeModule = {
  isAvailable(): boolean;
  encodeFile(inputPath: string, outputPath: string, quality: number): Promise<void>;
  decodeFile(inputPath: string, outputPath: string): Promise<void>;
};

const native = requireOptionalNativeModule<FloraFrcINativeModule>("FloraFrcI");

export function isFloraFrcIAvailable(): boolean {
  try {
    return native?.isAvailable() === true;
  } catch {
    return false;
  }
}

export async function encodeImageFileToFrc(
  inputPath: string,
  outputPath: string,
  quality = 75,
): Promise<void> {
  if (!native) throw new Error("FRC-I native module недоступен");
  await native.encodeFile(inputPath, outputPath, quality);
}

export async function decodeFrcFileToPng(inputPath: string, outputPath: string): Promise<void> {
  if (!native) throw new Error("FRC-I native module недоступен");
  await native.decodeFile(inputPath, outputPath);
}
