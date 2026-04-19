import { createAntTool } from './ant';
import { createBashTool } from './bash';
import { createEditTool } from './edit';
import { createReadTool } from './read';
import { createWriteTool } from './write';
import { createOracleTool } from './oracle';
import { createWebSearchTool } from './web';
import { createRipgrepTool } from './ripgrep';
import { createSubagentTool } from './subagent';
import { createUndoTool } from './undo';
import type { ToolFactoryOptions } from './types';
import { createPlanningModeTool } from './planning-mode';
import { createChoiceSelectorTool } from './choice-selector';
import { createCiRunsTool, createCiWorkflowsTool } from './ci';

import { createTestAnalyzeTool, createTestDetectTool, createTestRunTool, createTestScaffoldTool } from './test';
import { createGitConflictsTool, createGitIntegrateTool, createGitProgressTool, createGitStatusTool } from './gitops';
import { createDepsImpactTool, createDepsPackagesTool, createDepsScanTool, createSymbolRenameTool, createVerifyChangesTool } from './deps';

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
  const undo = createUndoTool(options);
  const bash = createBashTool(options);
  const ant = createAntTool(options);
  const choiceSelector = createChoiceSelectorTool(options);
  const webSearch = createWebSearchTool();
  const testDetect = createTestDetectTool(options);
  const testAnalyze = createTestAnalyzeTool(options);
  const testScaffold = createTestScaffoldTool(options);
  const testRun = createTestRunTool(options);
  const ciWorkflows = createCiWorkflowsTool(options);
  const ciRuns = createCiRunsTool(options);
  const gitStatus = createGitStatusTool(options);
  const gitConflicts = createGitConflictsTool(options);
  const gitIntegrate = createGitIntegrateTool(options);
  const gitProgress = createGitProgressTool(options);
  const depsScan = createDepsScanTool(options);
  const depsImpact = createDepsImpactTool(options);
  const depsPackages = createDepsPackagesTool(options);
  const symbolRename = createSymbolRenameTool(options);
  const verifyChanges = createVerifyChangesTool(options);
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
    undo,
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
    test_detect: testDetect,
    test_analyze: testAnalyze,
    test_scaffold: testScaffold,
    test_run: testRun,
    ci_workflows: ciWorkflows,
    ci_runs: ciRuns,
    git_status: gitStatus,
    git_conflicts: gitConflicts,
    git_integrate: gitIntegrate,
    git_progress: gitProgress,
    deps_scan: depsScan,
    deps_impact: depsImpact,
    deps_packages: depsPackages,
    symbol_rename: symbolRename,
    verify_changes: verifyChanges
  };
}
