import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "./types";
import { composerImageInputs, MAX_COMPOSER_IMAGE_TOTAL_BYTES } from "./composer-images";

function attachment(id: string, sizeBytes: number): ComposerAttachment {
  return {
    id,
    name: `${id}.png`,
    type: "image/png",
    sizeBytes,
    imageInput: {
      id,
      name: `${id}.png`,
      mediaType: "image/png",
      sizeBytes,
      width: 1,
      height: 1,
      dataUrl: "data:image/png;base64,pixels"
    }
  };
}

describe("composerImageInputs", () => {
  it("returns prepared transient inputs within the native envelope", () => {
    const image = attachment("one", 100);
    expect(composerImageInputs([image])).toEqual({ ok: true, images: [image.imageInput] });
  });

  it("fails closed for unfinished images and aggregate bytes", () => {
    const pending: ComposerAttachment = {
      id: "pending", name: "pending.png", type: "image/png", sizeBytes: 12
    };
    expect(composerImageInputs([pending])).toMatchObject({ ok: false });
    expect(composerImageInputs([
      attachment("one", MAX_COMPOSER_IMAGE_TOTAL_BYTES),
      attachment("two", 1)
    ])).toMatchObject({ ok: false, error: expect.stringContaining("total") });
  });
});
