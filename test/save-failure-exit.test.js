// Independent regression DRAFT. Not run; new acceptance checks are expected RED
// until the suggested production patch is applied. No browser, runtime or files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SingleController } from '../src/local-single-video/controller.mjs';

const target = { classroomId: 'SyntheticDiscard', title: 'Synthetic clip', page: 1, index: 0 };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function singleFixture(code) {
  let writes = 0, failure = code ? Object.assign(new Error(code), { code }) : null;
  const single = new SingleController({ dataDir: '.', appData: '.', target,
    connectExistingBridge: false, sessionProvider: async () => { throw new Error('NO_BROWSER_IN_DRAFT'); },
    positionStore: { save: async () => { writes++; if (failure) throw failure; } } });
  // Do not call init(): the test needs only the actual persist/dispose/status path.
  single.record = { playerIdentity: null };
  return { single, get writes() { return writes; }, clearFailure() { failure = null; } };
}

for (const code of ['EIO', 'ENOSPC']) test(`Single ${code}: cleanup before explicit discard, no additional writes`, async () => {
  const f = singleFixture(code);
  await assert.rejects(f.single.persist(), error => error.code === code);
  assert.equal(f.single.status().discardAvailable, false, 'save failure alone is not an exit capability');
  const gate = deferred(); let closed = false;
  f.single.page = { isClosed: () => closed, close: async () => { await gate.promise; closed = true; } };
  const finishing = f.single.dispose(); const rejected = assert.rejects(finishing, error => error.code === code);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.single.status().discardAvailable, false, 'owned page close still pending');
  gate.resolve(); await rejected;
  assert.equal(closed, true);
  assert.equal(f.single.status().discardAvailable, true, 'settled genuine save failure is explicitly discardable');
  const before = f.writes;
  await f.single.dispose({ discardUnsavedPosition: true });
  assert.equal(f.writes, before, 'discard never retries or overwrites the position record');
});

test('playback failures or a reason string do not confer discard capability', async () => {
  for (const code of ['PLAY_NOT_STARTED', 'CHECKPOINT', 'VERIFICATION_REQUIRED', 'MEDIA_ERROR', 'EIO']) {
    const f = singleFixture(null); f.single.actionError = code;
    assert.equal(f.single.status().discardAvailable, false);
  }
});

test('transient I/O error still exits by successful ordinary retry', async () => {
  const f = singleFixture('EIO');
  await assert.rejects(f.single.dispose(), error => error.code === 'EIO');
  f.clearFailure(); await f.single.dispose();
  assert.equal(f.single.persistError, null);
  assert.equal(f.single.status().discardAvailable, false);
});

test('failed or unknown page close cannot expose save discard, and busy work revokes it', async () => {
  for (const unknown of [false,true]) {
    const f=singleFixture('EIO');
    f.single.page=unknown?{close:async()=>{}}:{isClosed:()=>false,close:async()=>{throw new Error('PAGE_CLOSE_FAILED');}};
    await assert.rejects(f.single.dispose());assert.equal(f.single.canDiscardSaveFailure(),false);
  }
  const f=singleFixture('EIO');await assert.rejects(f.single.dispose());assert.equal(f.single.canDiscardSaveFailure(),true);
  f.single.busy=true;assert.equal(f.single.canDiscardSaveFailure(),false);f.single.busy=false;
  f.single.pendingPlay=Promise.resolve();assert.equal(f.single.canDiscardSaveFailure(),false);f.single.pendingPlay=null;
  f.single.ticking=Promise.resolve();assert.equal(f.single.canDiscardSaveFailure(),false);
});
