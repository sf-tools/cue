import type { ToolFactoryOptions } from './types';
import { createAntTool } from './ant';
import { createBashTool } from './bash';
import { createChoiceSelectorTool } from './choice-selector';
import { createCiTool } from './ci';
import { createDepsTool } from './deps';
import { createEditTool } from './edit';
import { createGitOpsTool } from './gitops';
import { createOracleTool } from './oracle';
import { createPlanningModeTool } from './planning-mode';
import { createReadTool } from './read';
import { createRipgrepTool } from './ripgrep';
import { createSubagentTool } from './subagent';
import { createTestTool } from './test';
import { createWebSearchTool } from './web';
import { createWriteTool } from './write';

import {
  createCommitSearchTool,
  createDiffTool,
  createLibrarianTool,
  createListDirectoryGitHubTool,
  createListRepositoriesTool,
  createReadGitHubTool,
  createSearchGitHubTool
} from './librarian';

export type { ToolFactoryOptions } from './types';

export function createTools(options: ToolFactoryOptions) {
  const read = createReadTool(options);
  const ripgrep = createRipgrepTool(options);
  const write = createWriteTool(options);
  const edit = createEditTool(options);
  const bash = createBashTool(options);
  const ant = createAntTool(options);
  const choiceSelector = createChoiceSelectorTool(options);
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
  const planningMode = createPlanningModeTool(options);
  const subagent = createSubagentTool(options);
  const librarian = createLibrarianTool(options);
  const readGitHub = createReadGitHubTool(options);
  const searchGitHub = createSearchGitHubTool(options);
  const listDirectoryGitHub = createListDirectoryGitHubTool(options);
  const listRepositories = createListRepositoriesTool(options);
  const commitSearch = createCommitSearchTool(options);
  const diff = createDiffTool(options);

  return {
    read,
    ripgrep,
    rg: ripgrep,
    write,
    edit,
    bash,
    ant,
    choice_selector: choiceSelector,
    web_search: webSearch,
    oracle,
    planning_mode: planningMode,
    subagent,
    librarian,
    read_github: readGitHub,
    search_github: searchGitHub,
    list_directory_github: listDirectoryGitHub,
    list_repositories: listRepositories,
    commit_search: commitSearch,
    diff,
    test,
    ci,
    gitops,
    deps
  };
}
