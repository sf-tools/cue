import '@/agent/early-stdin';
import { AgentApp } from '@/agent/app';
import { handleCliArgs } from '@/cli';

const cli = handleCliArgs();
if (cli.kind === 'exit') process.exit(cli.code);

const app = new AgentApp();

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => {
  app.handleFatalError(error);
});
