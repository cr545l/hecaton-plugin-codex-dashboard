'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationDelivery } = require('../lib/notification-delivery');
const { createHookServiceClient } = require('../lib/hook-service-client');

const payload = { terminal_id: 42, title: 'Codex', body: 'Done.' };

test('no_terminal in a headless service delegates to exactly one UI and remembers the host limitation', async () => {
  let direct = 0;
  const calls = [];
  global.hecaton = { notify: { send: async () => { direct++; return { ok: false, error_code: 'no_terminal' }; } } };
  const delivery = createNotificationDelivery({ clients: () => [1, 2],
    request: async (...args) => { calls.push(args); return { ok: true }; } });
  assert.deepEqual(await delivery.send(payload), { ok: true });
  assert.deepEqual(await delivery.send(payload), { ok: true });
  assert.equal(direct, 1);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [[2, 'notify.send', payload], [2, 'notify.send', payload]]);
});

test('hosts supporting service notifications keep sending directly', async () => {
  global.hecaton = { notify: { send: async () => ({ ok: true, event_id: 'direct' }) } };
  const delivery = createNotificationDelivery({ clients: () => { throw Error('must not delegate'); } });
  assert.deepEqual(await delivery.send(payload), { ok: true, event_id: 'direct' });
});

test('a served UI without a terminal is skipped; notification denial is respected', async () => {
  const calls = [];
  global.hecaton = { notify: { send: async () => ({ ok: false, error_code: 'no_terminal' }) } };
  const delivery = createNotificationDelivery({ clients: () => [1, 2, 3], request: async (link) => {
    calls.push(link);
    return { ok: false, error_code: link === 3 ? 'no_terminal' : 'access_denied' };
  } });
  assert.deepEqual(await delivery.send(payload), { ok: false, error_code: 'access_denied' });
  assert.deepEqual(calls, [3, 2]);
});

test('a timeout never repeats an ambiguous notification on another window', async () => {
  const calls = [];
  global.hecaton = { notify: { send: async () => ({ ok: false, error_code: 'no_terminal' }) } };
  const delivery = createNotificationDelivery({ clients: () => [1, 2], request: async (link) => {
    calls.push(link); throw new Error('request timed out');
  } });
  assert.equal((await delivery.send(payload)).error_code, 'notification_delivery_failed');
  assert.deepEqual(calls, [2]);
});

test('missing UI returns a specific limitation and recovers when a window connects', async () => {
  let clients = [];
  global.hecaton = { notify: { send: async () => { throw Object.assign(Error('No terminal'), { code: 'no_terminal' }); } } };
  const delivery = createNotificationDelivery({ clients: () => clients, request: async () => ({ ok: true }) });
  assert.equal((await delivery.send(payload)).error_code, 'no_notification_window');
  clients = [4];
  assert.deepEqual(await delivery.send(payload), { ok: true });
});

test('the UI service client handles notify.send requests and refuses them after closing', async () => {
  let options;
  const calls = [];
  global.hecaton = {
    notify: { send: async (p) => { calls.push(p); return { ok: true, event_id: 'ui' }; } },
    serviceChannel: (opts) => {
      options = opts;
      return { connect: async () => {}, request: async () => ({}), close: async () => {} };
    },
  };
  const client = createHookServiceClient({ onState: () => {}, onError: (e) => { throw e; } });
  await client.request();
  assert.deepEqual(await options.onRequest('notify.send', payload), { ok: true, event_id: 'ui' });
  await assert.rejects(options.onRequest('terminal.send_command', {}), /Unknown UI request/);
  await client.close();
  assert.equal((await options.onRequest('notify.send', payload)).error_code, 'no_terminal');
  assert.deepEqual(calls, [payload]);
});
