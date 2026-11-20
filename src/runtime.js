import path from 'node:path';
import { createController } from './controller.js';
import { ChromeCourse, launchChrome } from './chrome.js';
import { loadInventory, saveInventory } from './inventory-store.js';
import { createServer } from './server.js';
import { listenOnBrowserSafePort } from './loopback-port.js';
import { prepareDataUpgrade } from './data-upgrade.js';

export async function startLocalRuntime({ dataDir, profileDir = path.join(dataDir, 'chrome-profile'), port = 0,
  browserPath, csrfToken, launch, choosePort, appVersion } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('必须指定本机数据目录');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT 必须是有效端口号');
  if (appVersion) await prepareDataUpgrade({ dataDir, appVersion });

  const inventoryFile = path.join(dataDir, 'course-inventory.json');
  const controller = createController({
    launch: () => launch ? launch(profileDir, browserPath) : launchChrome(profileDir, browserPath),
    makeCourse: (session, listUrl) => new ChromeCourse(session.context, session.page, listUrl),
    initialInventory: await loadInventory(inventoryFile),
    saveInventory: snapshot => saveInventory(inventoryFile, snapshot),
  });
  const server = createServer(controller, { csrfToken });
  await listenOnBrowserSafePort(server, { port, choosePort });
  let closePromise;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    server,
    controller,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try { await controller.shutdown(); }
        finally {
          if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      })().catch(error => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    },
  };
}
