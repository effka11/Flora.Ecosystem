"use client";

import type { ImgHTMLAttributes } from "react";
import { useFrcImageSource } from "@/lib/frcImageSource";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
};

export function FrcImage({ src, ...props }: Props) {
  const resolved = useFrcImageSource(src);
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      {...props}
      src={resolved.source || undefined}
      data-frc-loading={resolved.loading || undefined}
      data-frc-error={resolved.error || undefined}
    />
  );
}
