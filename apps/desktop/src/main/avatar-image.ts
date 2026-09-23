import { MAXIMUM_AVATAR_BYTES, MAXIMUM_AVATAR_DIMENSION } from "@kiwi/contracts";

export interface AvatarRaster {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality: "best" }): AvatarRaster;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

export interface PreparedAvatar {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export function prepareAvatarImage(
  image: AvatarRaster,
  sourceBytes: Buffer,
  sourceMediaType: "image/png" | "image/jpeg" | "image/webp",
): PreparedAvatar | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return null;

  if (
    width <= MAXIMUM_AVATAR_DIMENSION &&
    height <= MAXIMUM_AVATAR_DIMENSION &&
    sourceBytes.byteLength <= MAXIMUM_AVATAR_BYTES
  ) {
    return { bytes: sourceBytes, mediaType: sourceMediaType };
  }

  const resized =
    width >= height
      ? image.resize({ width: MAXIMUM_AVATAR_DIMENSION, quality: "best" })
      : image.resize({ height: MAXIMUM_AVATAR_DIMENSION, quality: "best" });
  if (sourceMediaType === "image/png") {
    const png = resized.toPNG();
    if (png.byteLength > 0 && png.byteLength <= MAXIMUM_AVATAR_BYTES) {
      return { bytes: png, mediaType: "image/png" };
    }
  }
  for (const quality of [88, 76, 64]) {
    const jpeg = resized.toJPEG(quality);
    if (jpeg.byteLength > 0 && jpeg.byteLength <= MAXIMUM_AVATAR_BYTES) {
      return { bytes: jpeg, mediaType: "image/jpeg" };
    }
  }
  return null;
}
