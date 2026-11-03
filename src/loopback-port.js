import { randomInt } from 'node:crypto';

const FIRST_PRIVATE_PORT = 49_152;
const LAST_PRIVATE_PORT = 65_534;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(port, '127.0.0.1'); }
    catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

export async function listenOnBrowserSafePort(server, {
  port = 0,
  choosePort = () => randomInt(FIRST_PRIVATE_PORT, LAST_PRIVATE_PORT + 1),
  maxAttempts = 32,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('invalid port');
  if (port !== 0) return listen(server, port);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = choosePort();
    if (!Number.isInteger(candidate) || candidate < FIRST_PRIVATE_PORT || candidate > LAST_PRIVATE_PORT) continue;
    try { return await listen(server, candidate); }
    catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('无法分配浏览器可访问的本机端口');
}
