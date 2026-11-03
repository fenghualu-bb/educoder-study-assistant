import { fileURLToPath } from 'node:url';
import { startLocalRuntime } from './runtime.js';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const port = Number(process.env.PORT ?? 4319);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT 必须是有效端口号');

const runtime = await startLocalRuntime({ dataDir, port });
process.stdout.write(`本机控制台：${runtime.origin}\n`);
