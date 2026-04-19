import type { ToolFactoryOptions } from './types';
import { createBashTool } from './bash';
import { createCiTool } from './ci';
import { createDepsTool } from './deps';
import { createEditTool } from './edit';
import { createGitOpsTool } from './gitops';
import { createReadTool } from './read';
import { createRipgrepTool } from './ripgrep';
import { createTestTool } from './test';
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
    web_search: createWebSearchTool(),
    test: createTestTool(options),
    ci: createCiTool(options),
    gitops: createGitOpsTool(options),
    deps: createDepsTool(options)
  };
}
