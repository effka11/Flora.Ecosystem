import { useCallback, useEffect, useRef, useState } from "react";
import { floraNewUuid } from "@/lib/floraUuid";
import { mergeMessageImageFiles, type MergeMessageImagesResult } from "@/lib/messageImages";
import {
  cancelMessageImagePrepare,
  scheduleMessageImagePrepare,
} from "@/lib/messageImageSendPrepare";
import {
  cancelMessageVideoPrepare,
  scheduleMessageVideoPrepare,
} from "@/lib/messageVideoSendPrepare";
import { cancelVoicePrepare, scheduleVoiceTranscode } from "@/lib/voiceSendPrepare";
import type { DraftVoiceBlock } from "./messageBlocks";
import type { RecordedVoiceDraft } from "./useVoiceRecorder";

export type ComposeMode = "text" | "voice";

export type DraftImage = {
  id: string;
  sourceFile: File;
  objectUrl: string;
  preparing: boolean;
};

export type DraftVideo = {
  id: string;
  sourceFile: File;
  objectUrl: string;
  contentType: string;
  durationMs: number;
  width: number;
  height: number;
  preparing: boolean;
};

function makeVoiceBlock(voice: RecordedVoiceDraft): DraftVoiceBlock {
  return {
    id: floraNewUuid(),
    kind: "voice",
    blob: voice.blob,
    objectUrl: URL.createObjectURL(voice.blob),
    durationMs: voice.durationMs,
    waveform: voice.waveform,
    contentType: voice.contentType,
  };
}

export function useMessageComposeDraft() {
  const [mode, setMode] = useState<ComposeMode>("text");
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const imagesRef = useRef<DraftImage[]>([]);
  const [videos, setVideos] = useState<DraftVideo[]>([]);
  const videosRef = useRef<DraftVideo[]>([]);
  const [voice, setVoice] = useState<DraftVoiceBlock | null>(null);
  const voiceRef = useRef<DraftVoiceBlock | null>(null);

  imagesRef.current = images;
  videosRef.current = videos;
  voiceRef.current = voice;

  useEffect(
    () => () => {
      if (voiceRef.current) URL.revokeObjectURL(voiceRef.current.objectUrl);
      for (const image of imagesRef.current) URL.revokeObjectURL(image.objectUrl);
      for (const video of videosRef.current) URL.revokeObjectURL(video.objectUrl);
    },
    [],
  );

  const clearVoice = useCallback(() => {
    setVoice((prev) => {
      if (prev) {
        cancelVoicePrepare(prev.id);
        URL.revokeObjectURL(prev.objectUrl);
      }
      return null;
    });
  }, []);

  const setVoiceFromRecording = useCallback((recorded: RecordedVoiceDraft) => {
    setVoice((prev) => {
      if (prev) {
        cancelVoicePrepare(prev.id);
        URL.revokeObjectURL(prev.objectUrl);
      }
      const block = makeVoiceBlock(recorded);
      void scheduleVoiceTranscode(block.id, block.blob);
      return block;
    });
  }, []);

  const openVoiceMode = useCallback(() => {
    setMode("voice");
  }, []);

  const openTextMode = useCallback(() => {
    setMode("text");
  }, []);

  const mergeImages = useCallback((files: FileList | File[]): MergeMessageImagesResult => {
    const prev = imagesRef.current;
    const result = mergeMessageImageFiles(
      prev.map((image) => image.sourceFile),
      files,
    );

    const nextDrafts: DraftImage[] = [];
    for (const file of result.next) {
      const existing = prev.find((image) => image.sourceFile === file);
      if (existing) {
        nextDrafts.push(existing);
        continue;
      }

      const id = floraNewUuid();
      const draft: DraftImage = {
        id,
        sourceFile: file,
        objectUrl: URL.createObjectURL(file),
        preparing: true,
      };
      void scheduleMessageImagePrepare(id, file)
        .then(() => {
          setImages((current) =>
            current.map((image) => (image.id === id ? { ...image, preparing: false } : image)),
          );
        })
        .catch(() => {
          setImages((current) => {
            const item = current.find((image) => image.id === id);
            if (item) URL.revokeObjectURL(item.objectUrl);
            return current.filter((image) => image.id !== id);
          });
        });
      nextDrafts.push(draft);
    }

    for (const removed of prev) {
      if (!nextDrafts.some((image) => image.id === removed.id)) {
        cancelMessageImagePrepare(removed.id);
        URL.revokeObjectURL(removed.objectUrl);
      }
    }

    setImages(nextDrafts);
    return result;
  }, []);

  const removeImageAt = useCallback((index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) {
        cancelMessageImagePrepare(removed.id);
        URL.revokeObjectURL(removed.objectUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearImages = useCallback(() => {
    setImages((prev) => {
      for (const image of prev) {
        cancelMessageImagePrepare(image.id);
        URL.revokeObjectURL(image.objectUrl);
      }
      return [];
    });
  }, []);

  const addVideoFromFile = useCallback((file: File) => {
    const id = floraNewUuid();
    const objectUrl = URL.createObjectURL(file);
    const placeholder: DraftVideo = {
      id,
      sourceFile: file,
      objectUrl,
      contentType: file.type || "video/mp4",
      durationMs: 0,
      width: 0,
      height: 0,
      preparing: true,
    };

    setVideos((prev) => {
      for (const video of prev) {
        cancelMessageVideoPrepare(video.id);
        URL.revokeObjectURL(video.objectUrl);
      }
      return [placeholder];
    });

    void scheduleMessageVideoPrepare(id, file)
      .then((prepared) => {
        setVideos((current) => {
          const item = current.find((video) => video.id === id);
          if (!item) return current;
          URL.revokeObjectURL(item.objectUrl);
          return current.map((video) =>
            video.id === id
              ? {
                  ...video,
                  objectUrl: URL.createObjectURL(prepared.blob),
                  contentType: prepared.contentType,
                  durationMs: prepared.durationMs,
                  width: prepared.width,
                  height: prepared.height,
                  preparing: false,
                }
              : video,
          );
        });
      })
      .catch(() => {
        setVideos((current) => {
          const item = current.find((video) => video.id === id);
          if (item) URL.revokeObjectURL(item.objectUrl);
          return current.filter((video) => video.id !== id);
        });
      });
  }, []);

  const removeVideoAt = useCallback((index: number) => {
    setVideos((prev) =>
      prev.filter((video, i) => {
        if (i !== index) return true;
        cancelMessageVideoPrepare(video.id);
        URL.revokeObjectURL(video.objectUrl);
        return false;
      }),
    );
  }, []);

  const clearVideos = useCallback(() => {
    setVideos((prev) => {
      for (const video of prev) {
        cancelMessageVideoPrepare(video.id);
        URL.revokeObjectURL(video.objectUrl);
      }
      return [];
    });
  }, []);

  const reset = useCallback(() => {
    setText("");
    clearVoice();
    clearImages();
    clearVideos();
    setMode("text");
  }, [clearVoice, clearImages, clearVideos]);

  const canSend =
    mode === "text" ? text.trim().length > 0 || images.length > 0 || videos.length > 0 : voice !== null;

  const mediaPreparing =
    images.some((image) => image.preparing) || videos.some((video) => video.preparing);

  return {
    mode,
    text,
    setText,
    images,
    mergeImages,
    removeImageAt,
    clearImages,
    videos,
    addVideoFromFile,
    removeVideoAt,
    clearVideos,
    mediaPreparing,
    voice,
    setVoiceFromRecording,
    clearVoice,
    openVoiceMode,
    openTextMode,
    reset,
    canSend,
  };
}
