import { t } from './i18n';

/**
 * Pictures pasted or dropped into the prompt box. The shell takes at most 256 KB of parameters per call,
 * so each one is scaled down and re-encoded until it fits; smaller pictures also cost the model fewer tokens.
 */

/** Raw bytes per picture, so its base64 fits the shell's 256 KB parameter limit with room to spare. */
export const MAX_PICTURE_BYTES = 180 * 1024;
/** Longest edge sent to the model; larger pictures are scaled down by the API anyway. */
export const MAX_EDGE = 1568;
/** Pictures per message (MAX_ATTACHMENTS in the sidecar). */
export const MAX_PICTURES = 4;

export function isPicture(file: { type: string }): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(file.type);
}

/** Width and height that fit `edge` on the longest side, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, edge: number): [number, number] {
  const scale = Math.min(1, edge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 of the picture, as-is when it is small enough, otherwise scaled down as JPEG until it fits. */
export async function preparePicture(file: Blob): Promise<string> {
  if (file.size <= MAX_PICTURE_BYTES) return toBase64(await file.arrayBuffer());
  const bmp = await createImageBitmap(file);
  let edge = Math.min(MAX_EDGE, Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const [w, h] = fitWithin(bmp.width, bmp.height, edge);
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [w, h];
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_PICTURE_BYTES) return toBase64(await blob.arrayBuffer());
    }
    edge = Math.round(edge * 0.75);
  }
  throw new Error(t('That picture is too big to send, even scaled down.'));
}
