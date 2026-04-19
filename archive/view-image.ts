import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

const MAX_BYTES = 8 * 1024 * 1024;

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function readGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (sig !== 'GIF') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > bytes.length) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const height = view.getUint16(i + 3, false);
      const width = view.getUint16(i + 5, false);
      return { width, height };
    }
    if (i + 2 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint16(i, false);
    i += length;
  }
  return null;
}

function inferDimensions(bytes: Uint8Array, mediaType: string) {
  if (mediaType === 'image/png') return readPngDimensions(bytes);
  if (mediaType === 'image/jpeg') return readJpegDimensions(bytes);
  if (mediaType === 'image/gif') return readGifDimensions(bytes);
  return null;
}

export function createViewImageTool() {
  return tool({
    description:
      'Load a local image (.png/.jpg/.gif/.webp/.bmp/.svg) so the model can see it. Use for screenshots, diagrams, design mocks, error UI captures, or any visual context.',
    inputSchema: z.object({
      path: z.string().min(1)
    }),
    execute: async ({ path }) => {
      const ext = extname(path).toLowerCase();
      const mediaType = MEDIA_TYPES[ext];
      if (!mediaType) throw new Error(`unsupported image type: ${ext || '(no extension)'}`);

      const info = await stat(path);
      if (!info.isFile()) throw new Error(`${path} is not a file`);
      if (info.size > MAX_BYTES) throw new Error(`image too large: ${info.size} bytes (max ${MAX_BYTES})`);

      const bytes = await readFile(path);
      const base64 = bytes.toString('base64');
      const dims = inferDimensions(bytes, mediaType);
      const dimText = dims ? ` (${dims.width}×${dims.height})` : '';
      return {
        path,
        mediaType,
        base64,
        bytes: bytes.length,
        summary: `${path} · ${mediaType} · ${bytes.length} bytes${dimText}`
      };
    },
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [
        { type: 'text', text: `loaded image: ${output.summary}` },
        { type: 'file-data', data: output.base64, mediaType: output.mediaType }
      ]
    })
  });
}
