import type { ToolFactoryOptions } from './types';
import { createBashTool } from './bash';
import { createEditTool } from './edit';
import { createReadTool } from './read';
import { createRipgrepTool } from './ripgrep';
import { createWebSearchTool } from './web';
import { createWriteTool } from './write';

export type { ToolFactoryOptions } from './types';

export function createTools(options: ToolFactoryOptions) {
  return {
    read: createReadTool(options),
    ripgrep: createRipgrepTool(options),
    rg: createRipgrepTool(options),
    write: createWriteTool(options),
    edit: createEditTool(options),
    bash: createBashTool(options),
    web_search: createWebSearchTool()
  };
}
