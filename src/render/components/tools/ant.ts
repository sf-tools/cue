import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { arrayProp, previewLines, renderToolCard, stringProp } from './shared';

export function renderAntTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const script = stringProp(entry.input, 'script') || '';
  const args =
    arrayProp(entry.input, 'args')
      ?.filter(value => typeof value === 'string')
      .map(value => String(value)) || [];
  const detail = args.length
    ? `script.js · ${args.length} arg${args.length === 1 ? '' : 's'}`
    : 'script.js';
  const output = typeof entry.output === 'string' ? entry.output : '';
  const inferredFailure = entry.status === 'completed' && output.startsWith('error:');
  const status = inferredFailure ? 'failed' : entry.status;
  const body =
    status === 'failed'
      ? [entry.errorText || output || 'ant execution failed']
      : [
          ...(args.length ? [`args: ${args.join(' ')}`] : []),
          'script:',
          ...previewLines(script.split('\n'), ctx, 8),
          ...(output.trim() ? ['output:', ...previewLines(output.split('\n'), ctx, 8)] : []),
        ];

  return renderToolCard({ name: 'ant', detail, body, status }, ctx);
}
