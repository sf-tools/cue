import { wrapTextBlock } from '@/render/layout';
import { line, span } from '@/render/primitives';
import type { Block, RenderContext } from '@/render/types';
import type { ToolHistoryEntry } from '@/types';
import { asRecord, renderToolCard, stringProp } from './shared';

export function renderChoiceSelectorTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const input = asRecord(entry.input);
  const output = asRecord(entry.output);
  const title = stringProp(input, 'title') || entry.title || 'choice';
  const selectedValue = stringProp(output, 'value');
  const selectedLabel = stringProp(output, 'label');
  const selectedDetail = stringProp(output, 'detail');

  if (entry.status === 'running') {
    return renderToolCard({ name: 'choice', detail: title, status: entry.status }, ctx);
  }

  const bodyBlock: Block = [];

  if (entry.status === 'failed') {
    bodyBlock.push(...wrapTextBlock(entry.errorText || 'choice selection failed', Math.max(1, ctx.width - 4), ctx.theme.dimmed));
    return renderToolCard({ name: 'choice', detail: title, bodyBlock, status: entry.status }, ctx);
  }

  if (selectedLabel || selectedValue) {
    bodyBlock.push(
      line(
        span('  '),
        span('picked ', ctx.theme.subtle),
        span(selectedLabel || selectedValue || 'option', ctx.theme.foreground),
        ...(selectedValue && selectedLabel && selectedValue !== selectedLabel ? [span(' · ', ctx.theme.subtle), span(selectedValue, ctx.theme.dimmed)] : [])
      )
    );

    if (selectedDetail) {
      bodyBlock.push(...wrapTextBlock(selectedDetail, Math.max(1, ctx.width - 6), ctx.theme.dimmed).map(detailLine => line(span('    '), ...detailLine.segments)));
    }
  }

  return renderToolCard({ name: 'choice', detail: title, bodyBlock, status: entry.status }, ctx);
}
