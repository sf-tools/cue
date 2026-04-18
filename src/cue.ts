import { AgentApp } from '@/agent/app';

const app = new AgentApp();

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => {
  app.handleFatalError(error);
});
