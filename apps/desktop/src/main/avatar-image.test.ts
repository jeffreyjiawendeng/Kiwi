import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_AVATAR_BYTES } from "@kiwi/contracts";
import { prepareAvatarImage, type AvatarRaster } from "./avatar-image.js";

function raster(options: {
  width: number;
  height: number;
  pngBytes?: number;
  jpegBytes?: number;
}): AvatarRaster & { resize: ReturnType<typeof vi.fn> } {
  const resized = {
    isEmpty: () => false,
    getSize: () => ({ width: 512, height: 320 }),
    resize: vi.fn(),
    toPNG: () => Buffer.alloc(options.pngBytes ?? 100),
    toJPEG: () => Buffer.alloc(options.jpegBytes ?? 100),
  } satisfies AvatarRaster;
  const source = {
    isEmpty: () => false,
    getSize: () => ({ width: options.width, height: options.height }),
    resize: vi.fn(() => resized),
    toPNG: () => Buffer.alloc(0),
    toJPEG: () => Buffer.alloc(0),
  } satisfies AvatarRaster;
  return source;
}

describe("avatar preparation", () => {
  it("keeps an already bounded image without re-encoding it", () => {
    const image = raster({ width: 320, height: 320 });
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);

    expect(prepareAvatarImage(image, bytes, "image/webp")).toEqual({
      bytes,
      mediaType: "image/webp",
    });
    expect(image.resize).not.toHaveBeenCalled();
  });

  it("downsamples a large portrait to the bounded dimension and stored size", () => {
    const image = raster({ width: 1200, height: 2400, pngBytes: 160_000 });
    const result = prepareAvatarImage(image, Buffer.alloc(2_000_000), "image/png");

    expect(image.resize).toHaveBeenCalledWith({ height: 512, quality: "best" });
    expect(result?.mediaType).toBe("image/png");
    expect(result?.bytes.byteLength).toBeLessThanOrEqual(MAXIMUM_AVATAR_BYTES);
  });

  it("uses a bounded JPEG when a resized PNG remains too large", () => {
    const image = raster({
      width: 1400,
      height: 900,
      pngBytes: MAXIMUM_AVATAR_BYTES + 1,
      jpegBytes: 120_000,
    });

    expect(prepareAvatarImage(image, Buffer.alloc(2_000_000), "image/png")?.mediaType).toBe(
      "image/jpeg",
    );
  });
});
