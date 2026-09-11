import { AgentBridgeFramework } from './framework.mjs';
import { CodexAppServerRuntime } from './app-server.mjs';
import { StdioAdapter } from './adapters/stdio.mjs';

const framework = new AgentBridgeFramework({ runtime: new CodexAppServerRuntime(), adapter: new StdioAdapter() });
await framework.start();
const stop = () => void framework.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

