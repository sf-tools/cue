import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { previewText, renderToolCard, stringProp } from './shared';

export function renderBashTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const cmd = stringProp(entry.input, 'cmd') || entry.title || 'command';
  const output = typeof entry.output === 'string' ? entry.output : '';
  const inferredFailure = entry.status === 'completed' && output.startsWith('error:');
  const status = inferredFailure ? 'failed' : entry.status;
  const body = [`$ ${cmd}`];

  if (status === 'failed') body.push(entry.errorText || output || 'command failed');
  else if (output.trim()) body.push(...previewText(output, ctx, 8));

  return renderToolCard({ name: 'bash', detail: cmd, body, status }, ctx);
}
