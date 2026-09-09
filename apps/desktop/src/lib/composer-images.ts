import type { NativeImageInput, NativeImageMediaType } from "@fable/protocol";
import { readFileAsDataUrl } from "./helpers";
import type { ComposerAttachment } from "./types";

export const COMPOSER_IMAGE_MEDIA_TYPES = new Set<NativeImageMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export const MAX_COMPOSER_IMAGE_COUNT = 4;
export const MAX_COMPOSER_IMAGE_TOTAL_BYTES = 1024 * 1024;
export const MAX_COMPOSER_IMAGE_DIMENSION = 8192;

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_COMPOSER_IMAGE_DIMENSION ||
        height > MAX_COMPOSER_IMAGE_DIMENSION
      ) {
        reject(new Error(`Choose an image no larger than ${MAX_COMPOSER_IMAGE_DIMENSION} pixels on either side.`));
        return;
      }
      resolve({ width, height });
    };
    image.onerror = () => reject(new Error("That image could not be decoded."));
    image.src = dataUrl;
  });
}

/** Prepare one transient model input. Callers must never persist its data URL. */
export async function prepareComposerImage(file: File, id: string): Promise<NativeImageInput> {
  if (!COMPOSER_IMAGE_MEDIA_TYPES.has(file.type as NativeImageMediaType)) {
    throw new Error("Choose a PNG, JPEG, or WebP image. GIF is not supported for image understanding.");
  }
  if (file.size < 1 || file.size > MAX_COMPOSER_IMAGE_TOTAL_BYTES) {
    throw new Error("Choose an image no larger than 1 MB.");
  }
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl.startsWith(`data:${file.type};base64,`)) {
    throw new Error("That image did not produce a supported local image payload.");
  }
  const dimensions = await imageDimensions(dataUrl);
  return {
    id,
    name: file.name.slice(0, 256) || "image",
    mediaType: file.type as NativeImageMediaType,
    sizeBytes: file.size,
    ...dimensions,
    dataUrl,
  };
}

export type ComposerImageValidation =
  | { ok: true; images: NativeImageInput[] }
  | { ok: false; error: string };

/** Collect only ready images and enforce the same aggregate limits as native staging. */
export function composerImageInputs(attachments: readonly ComposerAttachment[]): ComposerImageValidation {
  const imageAttachments = attachments.filter((attachment) => attachment.type.startsWith("image/"));
  if (imageAttachments.length > MAX_COMPOSER_IMAGE_COUNT) {
    return { ok: false, error: `Attach no more than ${MAX_COMPOSER_IMAGE_COUNT} images to one message.` };
  }
  const incomplete = imageAttachments.find((attachment) => !attachment.imageInput);
  if (incomplete) {
    return { ok: false, error: incomplete.status || `Finish preparing ${incomplete.name} before sending.` };
  }
  const images = imageAttachments.map((attachment) => attachment.imageInput!);
  const totalBytes = images.reduce((total, image) => total + image.sizeBytes, 0);
  if (totalBytes > MAX_COMPOSER_IMAGE_TOTAL_BYTES) {
    return { ok: false, error: "Attached images must total no more than 1 MB." };
  }
  return { ok: true, images };
}
