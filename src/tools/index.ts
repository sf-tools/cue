import type { ToolFactoryOptions } from './types';
import { createBashTool } from './bash';
import { createCiTool } from './ci';
import { createDepsTool } from './deps';
import { createEditTool } from './edit';
import { createGitOpsTool } from './gitops';
import { createOracleTool } from './oracle';
import { createReadTool } from './read';
import { createRipgrepTool } from './ripgrep';
import { createSubagentTool } from './subagent';
import { createTestTool } from './test';
import { createWebSearchTool } from './web';
import { createWriteTool } from './write';

export type { ToolFactoryOptions } from './types';

export function createTools(options: ToolFactoryOptions) {
  const read = createReadTool(options);
  const ripgrep = createRipgrepTool(options);
  const write = createWriteTool(options);
  const edit = createEditTool(options);
  const bash = createBashTool(options);
  const webSearch = createWebSearchTool();
  const test = createTestTool(options);
  const ci = createCiTool(options);
  const gitops = createGitOpsTool(options);
  const deps = createDepsTool(options);
  const oracle = createOracleTool(options, {
    read,
    ripgrep,
    web_search: webSearch
  });
  const subagent = createSubagentTool(options);

  return {
    read,
    ripgrep,
    rg: ripgrep,
    write,
    edit,
    bash,
    web_search: webSearch,
    oracle,
    subagent,
    test,
    ci,
    gitops,
    deps
  };
}
