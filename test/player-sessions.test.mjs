import assert from 'node:assert/strict';
import test from 'node:test';

let PlayerSessions;
let PlayerSessionError;
try {
  ({ PlayerSessions, PlayerSessionError } = await import('../lib/player-sessions.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function setup() {
  assert.equal(typeof PlayerSessions, 'function', 'the player session store must exist');
  let now = 1000;
  return { store: new PlayerSessions({ now: () => now }), advance(ms) { now += ms; } };
}

function hasStatus(status) {
  return error => error instanceof PlayerSessionError && error.status === status;
}

function observation(attachment, extra = {}) {
  return { videoId: attachment.videoId, revision: attachment.revision, state: 'cued', currentTime: 0, ...extra };
}

test('creates independent 32-byte capabilities with a fixed two-hour lifetime and no browser secret in state', () => {
  const { store } = setup();
  const first = store.create('M7lc1UVf-VE');
  const second = store.create('M7lc1UVf-VE');
  assert.match(first.playerRef, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.reportKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.playerRef, 'base64url').length, 32);
  assert.equal(Buffer.from(first.reportKey, 'base64url').length, 32);
  assert.notEqual(first.playerRef, first.reportKey);
  assert.notEqual(first.playerRef, second.playerRef);
  assert.notEqual(first.reportKey, second.reportKey);
  assert.equal(first.expiresAt, 7_201_000);
  const snapshot = store.getState(first.playerRef);
  assert.deepEqual(snapshot.requested, { videoId: 'M7lc1UVf-VE', revision: 1 });
  assert.equal(snapshot.observed, null);
  assert.equal(snapshot.ack, null);
  assert.equal(snapshot.stale, true);
  assert.equal(JSON.stringify(snapshot).includes(first.reportKey), false);
  assert.equal(Object.hasOwn(snapshot, 'reportKey'), false);
});

test('isolates commands, requested selection, and browser observations between two sessions', () => {
  const { store } = setup();
  const a = store.create('M7lc1UVf-VE');
  const b = store.create('dQw4w9WgXcQ');
  const attachedA = store.attach(a.playerRef, a.reportKey);
  const attachedB = store.attach(b.playerRef, b.reportKey);
  const command = store.queue(a.playerRef, { action: 'play' });
  assert.deepEqual(store.poll(b.playerRef, b.reportKey, attachedB.epoch, 0), { commands: [], detached: false });
  assert.equal(store.report(a.playerRef, a.reportKey, attachedA.epoch, observation(attachedA, { state: 'playing', currentTime: 9, ackCommandId: command.id })), true);
  assert.equal(store.getState(a.playerRef).observed.state, 'playing');
  assert.equal(store.getState(b.playerRef).observed, null);
  assert.deepEqual(store.getState(b.playerRef).requested, { videoId: 'dQw4w9WgXcQ', revision: 1 });
});

test('expires at the fixed deadline without renewal and distinguishes unknown capabilities', () => {
  const { store, advance } = setup();
  const session = store.create('M7lc1UVf-VE');
  advance(7_199_999);
  store.getState(session.playerRef);
  advance(1);
  assert.throws(() => store.getState(session.playerRef), hasStatus(410));
  assert.throws(() => store.queue(session.playerRef, { action: 'play' }), hasStatus(410));
  assert.throws(() => store.attach(session.playerRef, session.reportKey), hasStatus(410));
  assert.throws(() => store.getState('unknown-capability'), hasStatus(404));
});

test('requires the browser report key for attachment, polling, and observations', () => {
  const { store } = setup();
  const a = store.create('M7lc1UVf-VE');
  const b = store.create('dQw4w9WgXcQ');
  const attached = store.attach(a.playerRef, a.reportKey);
  for (const key of [b.reportKey, a.playerRef, '', null]) {
    assert.throws(() => store.attach(a.playerRef, key), hasStatus(403));
    assert.throws(() => store.poll(a.playerRef, key, attached.epoch, 0), hasStatus(403));
    assert.throws(() => store.report(a.playerRef, key, attached.epoch, observation(attached)), hasStatus(403));
  }
  assert.equal(store.getState(a.playerRef).observed, null);
});

test('keeps old observations distinct and rejects late reports after a video revision changes', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { state: 'playing', currentTime: 10 })), true);
  const selected = store.queue(session.playerRef, { action: 'select', videoId: 'dQw4w9WgXcQ', expectedRevision: 1 });
  assert.equal(selected.revision, 2);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { currentTime: 12, ackCommandId: selected.id })), false);
  const snapshot = store.getState(session.playerRef);
  assert.deepEqual(snapshot.requested, { videoId: 'dQw4w9WgXcQ', revision: 2 });
  assert.equal(snapshot.observed.videoId, 'M7lc1UVf-VE');
  assert.equal(snapshot.stale, true);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, { videoId: 'dQw4w9WgXcQ', revision: 2, state: 'cued', currentTime: 0, ackCommandId: selected.id }), true);
  assert.deepEqual(store.getState(session.playerRef).ack, { commandId: selected.id, revision: 2 });
});

test('rejects unissued, wrong-revision, and regressing acknowledgements', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  const first = store.queue(session.playerRef, { action: 'play' });
  const second = store.queue(session.playerRef, { action: 'pause' });
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { ackCommandId: 9000 })), false);
  assert.equal(store.getState(session.playerRef).observed, null);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { ackCommandId: second.id })), true);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { ackCommandId: first.id })), false);
  const selected = store.queue(session.playerRef, { action: 'select', videoId: 'dQw4w9WgXcQ' });
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, { videoId: selected.videoId, revision: selected.revision, state: 'cued', currentTime: 0, ackCommandId: second.id }), false);
});

test('the latest attachment detaches earlier browser reports and polling without losing unacknowledged commands', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const first = store.attach(session.playerRef, session.reportKey);
  const command = store.queue(session.playerRef, { action: 'pause' });
  const second = store.attach(session.playerRef, session.reportKey);
  assert.notEqual(first.epoch, second.epoch);
  assert.equal(second.afterCommandId, 0);
  assert.deepEqual(store.poll(session.playerRef, session.reportKey, first.epoch, 0), { commands: [], detached: true });
  assert.equal(store.report(session.playerRef, session.reportKey, first.epoch, observation(first)), false);
  assert.equal(store.poll(session.playerRef, session.reportKey, second.epoch, second.afterCommandId).commands[0].id, command.id);
  assert.equal(store.report(session.playerRef, session.reportKey, second.epoch, observation(second, { ackCommandId: command.id })), true);
  const third = store.attach(session.playerRef, session.reportKey);
  assert.equal(third.afterCommandId, command.id);
  assert.equal(store.getState(session.playerRef).stale, true);
});

test('queueing playback never fabricates a browser playing state or acknowledgement', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  store.queue(session.playerRef, { action: 'play' });
  assert.equal(store.getState(session.playerRef).observed, null);
  assert.equal(store.getState(session.playerRef).ack, null);
  store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { state: 'paused' }));
  store.queue(session.playerRef, { action: 'play' });
  assert.equal(store.getState(session.playerRef).observed.state, 'paused');
  assert.equal(store.getState(session.playerRef).ack, null);
});

test('marks observations stale after fifteen seconds and refreshes only on a browser report', () => {
  const { store, advance } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached));
  advance(15_000);
  assert.equal(store.getState(session.playerRef).stale, false);
  advance(1);
  store.queue(session.playerRef, { action: 'play' });
  assert.equal(store.getState(session.playerRef).stale, true);
  assert.equal(store.getState(session.playerRef).ageMs, 15_001);
  assert.equal(store.getState(session.playerRef).observedAt, 1000);
  store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { currentTime: 15 }));
  assert.equal(store.getState(session.playerRef).stale, false);
  assert.equal(store.getState(session.playerRef).observedAt, 16_001);
});

test('validates video IDs, actions, finite seek bounds, and expected revisions without mutation', () => {
  const { store } = setup();
  for (const id of ['', 'short', 'M7lc1UVf-VE!', null, 12345678901, ['M7lc1UVf-VE']]) assert.throws(() => store.create(id), hasStatus(400));
  const session = store.create('M7lc1UVf-VE');
  const invalid = [
    null, { action: 'unknown' }, { action: 'select', videoId: 'invalid' },
    ...[-1, 86401, NaN, Infinity, '10', undefined].map(seconds => ({ action: 'seek', seconds })),
    ...[0, -1, 1.5, '1'].map(expectedRevision => ({ action: 'play', expectedRevision })),
  ];
  for (const command of invalid) assert.throws(() => store.queue(session.playerRef, command), hasStatus(400));
  assert.throws(() => store.queue(session.playerRef, { action: 'select', videoId: 'dQw4w9WgXcQ', expectedRevision: 2 }), hasStatus(409));
  assert.deepEqual(store.getState(session.playerRef).requested, { videoId: 'M7lc1UVf-VE', revision: 1 });
  assert.equal(store.queue(session.playerRef, { action: 'seek', seconds: 0 }).seconds, 0);
  assert.equal(store.queue(session.playerRef, { action: 'seek', seconds: 86400 }).seconds, 86400);
});

test('rejects malformed browser observations without modifying accepted state', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  const invalid = [
    null, observation(attached, { state: 'ready' }), observation(attached, { revision: '1' }),
    observation(attached, { videoId: ['M7lc1UVf-VE'] }), observation(attached, { error: { secret: 'data' } }),
    ...[-1, 86401, NaN, Infinity, '1'].map(currentTime => observation(attached, { currentTime })),
    observation(attached, { ackCommandId: 0 }),
  ];
  for (const report of invalid) assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, report), false);
  assert.equal(store.getState(session.playerRef).observed, null);
  for (const state of ['playing', 'paused', 'cued', 'ended', 'buffering', 'unstarted', 'error']) {
    assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { state, error: state === 'error' ? '153' : undefined })), true);
  }
});

test('bounds queued commands to twenty while validating older issued ACKs in the same revision', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  for (let index = 0; index < 25; index += 1) store.queue(session.playerRef, { action: 'pause' });
  const polled = store.poll(session.playerRef, session.reportKey, attached.epoch, 0);
  assert.equal(polled.commands.length, 20);
  assert.equal(polled.commands[0].id, 6);
  assert.equal(polled.commands.at(-1).id, 25);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { ackCommandId: 1 })), true);
  assert.equal(store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached, { ackCommandId: 25 })), true);
  assert.deepEqual(store.poll(session.playerRef, session.reportKey, attached.epoch, 25), { commands: [], detached: false });
  assert.throws(() => store.poll(session.playerRef, session.reportKey, attached.epoch, -1), hasStatus(400));
  assert.throws(() => store.poll(session.playerRef, session.reportKey, attached.epoch, 26), hasStatus(400));
});

test('limits capacity to five hundred live sessions and admits a new session after expiry', () => {
  const { store, advance } = setup();
  for (let index = 0; index < 500; index += 1) store.create('M7lc1UVf-VE');
  assert.throws(() => store.create('M7lc1UVf-VE'), hasStatus(429));
  advance(7_200_000);
  const next = store.create('dQw4w9WgXcQ');
  assert.equal(store.getState(next.playerRef).requested.videoId, 'dQw4w9WgXcQ');
});

test('retains the current select command when subsequent commands overflow the buffer', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  const selected = store.queue(session.playerRef, { action: 'select', videoId: 'dQw4w9WgXcQ' });
  for (let index = 0; index < 25; index += 1) store.queue(session.playerRef, { action: 'pause' });
  const polled = store.poll(session.playerRef, session.reportKey, attached.epoch, 0);
  assert.equal(polled.commands.length, 20);
  assert.equal(polled.commands[0].id, selected.id);
  assert.equal(polled.commands[0].action, 'select');
  assert.equal(polled.commands[0].videoId, 'dQw4w9WgXcQ');
  assert.equal(polled.commands.at(-1).id, 26);
});

test('does not expose mutable internal commands or state through return values', () => {
  const { store } = setup();
  const session = store.create('M7lc1UVf-VE');
  const attached = store.attach(session.playerRef, session.reportKey);
  const command = store.queue(session.playerRef, { action: 'pause' });
  command.videoId = 'dQw4w9WgXcQ';
  const polled = store.poll(session.playerRef, session.reportKey, attached.epoch, 0);
  assert.equal(polled.commands[0].videoId, 'M7lc1UVf-VE');
  polled.commands[0].action = 'play';
  assert.equal(store.poll(session.playerRef, session.reportKey, attached.epoch, 0).commands[0].action, 'pause');
  store.report(session.playerRef, session.reportKey, attached.epoch, observation(attached));
  const snapshot = store.getState(session.playerRef);
  snapshot.requested.videoId = 'dQw4w9WgXcQ';
  snapshot.observed.state = 'playing';
  assert.equal(store.getState(session.playerRef).requested.videoId, 'M7lc1UVf-VE');
  assert.equal(store.getState(session.playerRef).observed.state, 'cued');
});
