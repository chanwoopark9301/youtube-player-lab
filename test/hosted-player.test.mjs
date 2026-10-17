import assert from 'node:assert/strict';
import test from 'node:test';
import { openWrapper, videoMessage } from './support/hosted-player-harness.mjs';

test('sets the referrer policy and load listener before navigating to the HTTPS player', () => {
  const wrapper = openWrapper();
  assert.deepEqual(wrapper.navigations, [{ src: 'https://player.example.test/player', referrerPolicy: 'strict-origin-when-cross-origin', hasLoadListener: true }]);
});

test('queues only the latest valid parent video until the child loads', () => {
  const wrapper = openWrapper();
  wrapper.message(wrapper.parent, videoMessage('M7lc1UVf-VE'));
  wrapper.message(wrapper.parent, videoMessage('dQw4w9WgXcQ'));
  assert.deepEqual(wrapper.sent, []);
  wrapper.load();
  assert.deepEqual(wrapper.sent, [{ message: videoMessage('dQw4w9WgXcQ'), targetOrigin: 'https://player.example.test' }]);
  wrapper.load();
  assert.equal(wrapper.sent.length, 1, 'a consumed queued video must not be resent');
});

test('rejects unrelated sources, unrelated methods, and malformed video IDs', () => {
  const wrapper = openWrapper();
  wrapper.message({}, videoMessage('M7lc1UVf-VE'));
  wrapper.message(wrapper.child, videoMessage('M7lc1UVf-VE'));
  for (const videoId of ['', 'short', 'M7lc1UVf-VE!', 'M7lc1UVf V', null, undefined, 12345678901, ['M7lc1UVf-VE']]) wrapper.message(wrapper.parent, videoMessage(videoId));
  wrapper.message(wrapper.parent, { method: 'other', params: { structuredContent: { videoId: 'M7lc1UVf-VE' } } });
  wrapper.message(wrapper.parent, null);
  wrapper.message(wrapper.parent, {});
  wrapper.load();
  assert.deepEqual(wrapper.sent, []);
  wrapper.message(wrapper.parent, videoMessage('M7lc1UVf-VE'));
  assert.deepEqual(wrapper.sent, [{ message: videoMessage('M7lc1UVf-VE'), targetOrigin: 'https://player.example.test' }], 'a valid parent message still forwards after rejected messages');
});

test('forwards subsequent parent videos to the exact player origin with only the video ID', () => {
  const wrapper = openWrapper();
  wrapper.load();
  wrapper.message(wrapper.parent, {
    jsonrpc: '2.0', id: 7, method: 'ui/notifications/tool-result',
    params: { content: [{ type: 'text', text: 'private host content' }], structuredContent: { videoId: 'aqz-KE-bpKQ', secret: 'private host field' }, _meta: { token: 'private host metadata' } },
  });
  assert.deepEqual(wrapper.sent, [{ message: videoMessage('aqz-KE-bpKQ'), targetOrigin: 'https://player.example.test' }]);
});

test('relays only valid UI-only reporting credentials and keeps them out of navigation queries',async()=>{
  const wrapper=openWrapper({topLevel:true});
  const connection={playerRef:'a'.repeat(43),reportKey:'b'.repeat(43)};
  wrapper.load();
  wrapper.receive({method:'ui/notifications/tool-result',params:{structuredContent:{videoId:'jNQXAC9IVRw'},_meta:{playerConnection:{...connection,secret:'do not relay'}}}});
  assert.deepEqual(wrapper.sent[0].message.params._meta,{playerConnection:connection});
  await wrapper.click('popup-button');
  const url=new URL(wrapper.opened[0][0]);
  assert.equal(url.searchParams.get('videoId'),'jNQXAC9IVRw');
  assert.equal(url.searchParams.has('reportKey'),false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('reportKey'),connection.reportKey);
});

test('ignores connection fields in model-visible content or malformed private metadata',()=>{
  const wrapper=openWrapper();wrapper.load();
  wrapper.receive({method:'ui/notifications/tool-result',params:{structuredContent:{videoId:'jNQXAC9IVRw',playerConnection:{playerRef:'a'.repeat(43),reportKey:'b'.repeat(43)}},_meta:{playerConnection:{playerRef:'short',reportKey:'b'.repeat(43)}}}});
  assert.equal(wrapper.sent[0].message.params._meta,undefined);
});
