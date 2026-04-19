import { handleCliArgs } from '@/cli';
import { runJsonHeadlessMode } from '@/headless/json-mode';
import { CueLoginCancelledError, ensureCueCloudLogin } from '@/cloud/login-gate';

const cli = handleCliArgs();

if (cli.kind === 'exit') process.exit(cli.code);

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

if (cli.kind === 'headless-json') process.exit(await runJsonHeadlessMode(cli));

const resumeId = cli.kind === 'start' ? cli.resumeId : undefined;
const resumeSnapshot = resumeId ? await import('@/agent/session-storage').then(module => module.loadCueSessionSnapshot(resumeId)) : null;

const initialState = resumeSnapshot
  ? await import('@/agent/session-storage').then(module => module.hydrateStateFromSnapshot(resumeSnapshot))
  : undefined;

await import('@/agent/early-stdin');
const { AgentApp } = await import('@/agent/app');

const app = new AgentApp({
  initialState,
  sessionId: resumeSnapshot?.sessionId
});

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => {
  app.handleFatalError(error);
});
