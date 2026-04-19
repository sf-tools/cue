import { handleCliArgs } from '@/cli';
import { CueLoginCancelledError, ensureCueCloudLogin } from '@/cloud/login-gate';
import { runJsonHeadlessMode } from '@/headless/json-mode';

async function ensureLoginOrExit() {
  try {
    await ensureCueCloudLogin();
  } catch (error) {
    if (error instanceof CueLoginCancelledError) {
      if (process.stdout.isTTY) process.stdout.write('\u001b[?25h');
      process.exit(0);
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

const cli = handleCliArgs();

if (cli.kind === 'exit') process.exit(cli.code);

if (cli.kind === 'headless-json') {
  await ensureLoginOrExit();
  process.exit(await runJsonHeadlessMode(cli));
}

let resumeId = cli.resumeId;

if (cli.resumePicker) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('--resume without an id requires an interactive terminal.\n');
    process.exit(1);
  }

  const { listCueSessionSnapshots } = await import('@/agent/session-storage');
  const sessions = await listCueSessionSnapshots({ cwd: process.cwd() });

  if (sessions.length === 0) {
    process.stderr.write('No saved threads found for this workspace.\n');
    process.exit(1);
  }

  const { selectCueResumeSession } = await import('@/resume-selector');
  const selection = await selectCueResumeSession(sessions, { workspacePath: process.cwd() });
  if (!selection) process.exit(0);
  resumeId = selection.sessionId;
}

const { hydrateStateFromSnapshot, loadCueSessionSnapshot } = await import('@/agent/session-storage');
const resumeSnapshot = resumeId ? await loadCueSessionSnapshot(resumeId) : null;

if (resumeId && !resumeSnapshot) {
  process.stderr.write(`No saved thread found for id '${resumeId}'.\n`);
  process.exit(1);
}

await ensureLoginOrExit();

const initialState = resumeSnapshot ? hydrateStateFromSnapshot(resumeSnapshot) : undefined;

await import('@/agent/early-stdin');
const { AgentApp } = await import('@/agent/app');

const app = new AgentApp({
  initialState,
  sessionId: resumeSnapshot?.sessionId,
  threadTitle: resumeSnapshot?.title,
});

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => {
  app.handleFatalError(error);
});
