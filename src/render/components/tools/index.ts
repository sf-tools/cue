import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { renderAntTool } from './ant';
import { renderBashTool } from './bash';
import { renderChoiceSelectorTool } from './choice-selector';
import { renderEditTool } from './edit';
import { renderReadTool } from './read';
import { renderRipgrepTool } from './ripgrep';
import { renderUndoTool } from './undo';
import { renderWriteTool } from './write';
import { renderGenericTool } from './generic';
import { renderWebSearchTool } from './web-search';

const renderers: Record<string, (entry: ToolHistoryEntry, ctx: RenderContext) => Block> = {
  ant: renderAntTool,
  bash: renderBashTool,
  choice_selector: renderChoiceSelectorTool,
  edit: renderEditTool,
  read: renderReadTool,
  ripgrep: renderRipgrepTool,
  rg: renderRipgrepTool,
  undo: renderUndoTool,
  write: renderWriteTool,
  web_search: renderWebSearchTool
};

export function renderToolHistoryEntry(entry: ToolHistoryEntry, ctx: RenderContext) {
  return (renderers[entry.toolName] || renderGenericTool)(entry, ctx);
}
