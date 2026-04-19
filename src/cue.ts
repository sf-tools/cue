import { handleCliArgs } from '@/cli';
import { runJsonHeadlessMode } from '@/headless/json-mode';

const cli = handleCliArgs();
if (cli.kind === 'exit') process.exit(cli.code);

if (cli.kind === 'headless-json') {
  process.exit(await runJsonHeadlessMode(cli));
}

await import('@/agent/early-stdin');
const { AgentApp } = await import('@/agent/app');
const app = new AgentApp();

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => {
  app.handleFatalError(error);
});
