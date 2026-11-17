import { createHash } from 'node:crypto';
import type { ImageContent } from '@earendil-works/pi-ai';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { isMime, type Store } from './store.ts';

/** Kept images fit 2048 px on the long side and ~1.5 MB (2 MB as base64), re-encoded as JPEG 85 only when they don't already. */
export const IMAGE_LIMITS = { maxWidth: 2048, maxHeight: 2048, maxBytes: 2 * 1024 * 1024, jpegQuality: 85 };

const hash = (image: ImageContent) => createHash('sha256').update(image.data).digest('hex').slice(0, 16);
/** How a message's image reads in memory: named by the image as the message holds it, before any shrinking, so it always gets the same name. */
export const imageRef = (image: ImageContent) => `[image ${hash(image)}]`;
const REF = /\[image ([0-9a-f]{16})\]/g;

export const isImage = (part: unknown): part is ImageContent => typeof part === 'object' && part !== null
  && 'type' in part && part.type === 'image' && 'data' in part && typeof part.data === 'string' && 'mimeType' in part && typeof part.mimeType === 'string';

/** Keeps each image of a message's content in the store, once per distinct image, shrunk to IMAGE_LIMITS. */
export async function saveImages(store: Store, content: unknown) {
  if (!Array.isArray(content)) return;
  for (const image of content.filter(isImage)) {
    const name = hash(image);
    if (await store.image(name)) continue;
    // Pi's own resizer (Photon, WASM), as its read tool uses: it returns small images untouched, and null if it can't decode.
    const kept = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, IMAGE_LIMITS) ?? image;
    if (isMime(kept.mimeType)) await store.putImage(name, kept.mimeType, Buffer.from(kept.data, 'base64'));
  }
}

/** The kept images a text refers to, with their names, in order, each once; ones never kept are skipped. */
export async function namedImages(store: Store, text: string): Promise<{ name: string; image: ImageContent }[]> {
  const names = [...new Set(Array.from(text.matchAll(REF), match => match[1]))], kept = await Promise.all(names.map(name => store.image(name)));
  return names.flatMap((name, k) => {
    const image = kept[k];
    return image ? [{ name, image: { type: 'image' as const, data: Buffer.from(image.data).toString('base64'), mimeType: image.mimeType } }] : [];
  });
}
/** The kept images a text refers to, in order, each once; ones never kept are skipped. */
export const loadImages = async (store: Store, text: string) => (await namedImages(store, text)).map(({ image }) => image);
