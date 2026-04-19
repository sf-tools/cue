import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { renderBashTool } from './bash';
import { renderEditTool } from './edit';
import { renderReadTool } from './read';
import { renderRipgrepTool } from './ripgrep';
import { renderWriteTool } from './write';
import { renderGenericTool } from './generic';
import { renderWebSearchTool } from './web-search';

const renderers: Record<string, (entry: ToolHistoryEntry, ctx: RenderContext) => Block> = {
  bash: renderBashTool,
  edit: renderEditTool,
  read: renderReadTool,
  ripgrep: renderRipgrepTool,
  write: renderWriteTool,
  web_search: renderWebSearchTool
};

export function renderToolHistoryEntry(entry: ToolHistoryEntry, ctx: RenderContext) {
  return (renderers[entry.toolName] || renderGenericTool)(entry, ctx);
}
