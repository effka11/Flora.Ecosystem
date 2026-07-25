import { requireOptionalNativeModule } from "expo-modules-core";

type FloraFrcINativeModule = {
  isAvailable(): boolean;
  encodeFile(inputPath: string, outputPath: string, quality: number): Promise<void>;
  decodeFile(inputPath: string, outputPath: string): Promise<void>;
  decodeFileScaled(
    inputPath: string,
    outputPath: string,
    maxDimension: number,
    quality: number,
  ): Promise<"jpeg" | "png">;
  readInfo(inputPath: string): Promise<{ width: number; height: number }>;
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

/** Декод FRI в масштабе показа. Возвращает формат записанного файла. */
export async function decodeFrcFileScaled(
  inputPath: string,
  outputPath: string,
  maxDimension: number,
  quality: number,
): Promise<"jpeg" | "png"> {
  if (!native) throw new Error("FRC-I native module недоступен");
  return native.decodeFileScaled(inputPath, outputPath, maxDimension, quality);
}

/** Размеры из 20-байтового заголовка, без декода тела. */
export async function readFrcInfo(inputPath: string): Promise<{ width: number; height: number }> {
  if (!native) throw new Error("FRC-I native module недоступен");
  return native.readInfo(inputPath);
}
