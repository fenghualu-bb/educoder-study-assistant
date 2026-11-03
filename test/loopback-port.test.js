import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenOnBrowserSafePort } from '../src/loopback-port.js';

test('random loopback listener rejects Chromium-blocked 10080 and binds a safe high port', async () => {
  const server = createServer((_, response) => response.end('ready'));
  let choices = 0;
  try {
    await listenOnBrowserSafePort(server, {
      choosePort: () => ++choices === 1 ? 10080 : 59000 + choices - 2,
    });
    const assigned = server.address().port;
    assert.ok(assigned >= 49152 && assigned <= 65534);
    assert.ok(choices >= 2);
    assert.equal((await fetch(`http://127.0.0.1:${assigned}/`)).status, 200);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});

test('random loopback listener retries when its first high port is already occupied', async () => {
  const blocker = createServer();
  const server = createServer();
  try {
    await listenOnBrowserSafePort(blocker);
    const occupied = blocker.address().port;
    let next = occupied;
    await listenOnBrowserSafePort(server, {
      choosePort: () => {
        const candidate = next;
        next = next === 65_534 ? 49_152 : next + 1;
        return candidate;
      },
    });
    assert.notEqual(server.address().port, occupied);
    assert.ok(server.address().port >= 49_152);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
  }
});
