import type { ToolFactoryOptions } from './types';
import { createBashTool } from './bash';
import { createReadTool } from './read';
import { createWriteTool } from './write';

export type { ToolFactoryOptions } from './types';

export function createTools(options: ToolFactoryOptions) {
  return {
    read: createReadTool(options),
    write: createWriteTool(options),
    bash: createBashTool(options)
  };
}
