import { readFile } from 'node:fs/promises';

import { tool } from 'ai';
import { z } from 'zod';

import { resolveExistingImagePath } from '@/agent/path-detect';
import { MAX_ATTACHMENT_BYTES } from '@/agent/image-attachments';
import type { ToolFactoryOptions } from './types';

export type ReadToolImageOutput = {
  kind: 'image';
  path: string;
  mediaType: string;
  bytes: number;
};

export type ReadToolOutput = string | ReadToolImageOutput;

function isReadToolImageOutput(value: unknown): value is ReadToolImageOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'image' &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { mediaType?: unknown }).mediaType === 'string' &&
    typeof (value as { bytes?: unknown }).bytes === 'number'
  );
}

export function createReadTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Read a file from disk. For text files, returns the file contents as a string. ' +
      'For image files (png, jpg, jpeg, gif, webp, bmp, svg), the image itself is attached ' +
      'to the tool result so you can inspect it visually — do not try to interpret the ' +
      'response as text bytes.',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }): Promise<ReadToolOutput> => {
      const image = resolveExistingImagePath(path);
      if (image) {
        const bytes = await readFile(image.absolutePath);
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `image too large: ${bytes.length} bytes (max ${MAX_ATTACHMENT_BYTES}). ` +
              `Ask the user to share a smaller version.`,
          );
        }
        return {
          kind: 'image',
          path: image.absolutePath,
          mediaType: image.mediaType,
          bytes: bytes.length,
        };
      }

      return await readFile(path, 'utf8');
    },
    toModelOutput: async ({ output }) => {
      if (isReadToolImageOutput(output)) {
        const bytes = await readFile(output.path);
        return {
          type: 'content',
          value: [
            {
              type: 'text',
              text:
                `Image file at ${output.path} (${output.mediaType}, ${output.bytes} bytes). ` +
                `The image is attached below — inspect it visually rather than as text.`,
            },
            {
              type: 'image-data',
              mediaType: output.mediaType,
              data: bytes.toString('base64'),
            },
          ],
        };
      }

      if (typeof output === 'string') return { type: 'text', value: output };
      return { type: 'json', value: (output ?? null) as never };
    },
  });
}
