const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHookService } = require('../lib/hook-service');
const { createHookServiceClient } = require('../lib/hook-service-client');

function harness({ failServe = false } = {}) {
  const channels = new Set();
  const calls = { serve: 0, stop: 0, marks: [], notices: [] };
  global.hecaton = {
    permissions: { query: async () => ({ state: 'granted' }) },
    web: {
      serve: async () => {
        calls.serve++;
        return failServe ? { ok: false, error: 'EADDRINUSE' } : { ok: true, server_id: 1 };
      },
      stop: async () => { calls.stop++; return { ok: true }; },
      set_http: async () => ({ ok: true }),
    },
    terminal: { add_bookmark: async (p) => { calls.marks.push(p); return { ok: true }; } },
    notify: { send: async (p) => { calls.notices.push(p); return { ok: true }; } },
    serviceChannel: (options) => {
      const ch = {
        connected: false, options,
        connect: async () => {
          if (ch.connected) return;
          ch.connected = true;
          channels.add(ch);
          options.onConnected();
        },
        request: (method, params) => core.request(method, params),
        close: async () => { ch.connected = false; channels.delete(ch); },
      };
      return ch;
    },
  };
  const core = createHookService({ config: {}, onChange: (state) => {
    for (const ch of channels) ch.options.onNotify('state', state);
  } });
  function ui() {
    const snapshots = [], errors = [];
    const client = createHookServiceClient({ onState: (s) => snapshots.push(s), onError: (e) => errors.push(e) });
    return { ...client, snapshots, errors };
  }
  const event = (terminal = 42) => core.onHttpRequest({ server_id: 1,
    body: JSON.stringify({ client: 'codex', event: 'Stop', terminal_id: terminal, hook: { last_assistant_message: 'Done.' } }),
  });
  return { core, calls, channels, ui, event, recover: () => { failServe = false; } };
}

test('UI close/reopen and multiple windows share one server and keep processing hooks', async () => {
  const h = harness();
  const first = h.ui(), second = h.ui();
  await Promise.all([first.request(), second.request()]);
  assert.equal(h.calls.serve, 1);
  await h.event();
  assert.equal(first.snapshots.at(-1).bookmarks.count, 1);
  assert.equal(second.snapshots.at(-1).bookmarks.count, 1);
  await first.close();
  await second.close();
  assert.equal(h.calls.stop, 0);
  await h.event(43);
  assert.equal(h.calls.notices.length, 2, 'hooks still run without UI clients');
  const reopened = h.ui();
  await reopened.request();
  assert.equal(h.calls.serve, 1);
  assert.equal(reopened.snapshots.at(-1).bookmarks.count, 2);
  await h.event(43);
  assert.equal(h.calls.notices.length, 2, 'dedupe survives UI reload');
  await h.core.shutdown();
  assert.equal(h.calls.stop, 1, 'only service shutdown owns listener disposal');
});

test('settings and retry act on the shared service and broadcast to all windows', async () => {
  const h = harness({ failServe: true });
  const a = h.ui(), b = h.ui();
  await a.request();
  await b.request();
  assert.equal(a.snapshots.at(-1).bookmarks.server, 'failed');
  h.recover();
  await a.request('retry');
  assert.equal(b.snapshots.at(-1).bookmarks.server, 'running');
  await a.request('configure', { bookmarks: false });
  assert.equal(h.calls.stop, 0, 'notifications still need the server');
  await b.request('configure', { notifications: false });
  assert.equal(h.calls.stop, 1);
  assert.deepEqual(a.snapshots.at(-1).enabled, { bookmarks: false, notifications: false });
  await a.request('configure', { notifications: true });
  assert.equal(b.snapshots.at(-1).bookmarks.server, 'running');
  await h.core.shutdown();
});

test('service reconnect resynchronizes state and errors are surfaced without a UI listener', async () => {
  const h = harness();
  const ui = h.ui();
  await ui.request();
  const channel = [...h.channels][0];
  channel.options.onDisconnected('exited');
  assert.equal(ui.errors.at(-1), 'service_disconnected');
  channel.options.onConnected();
  await new Promise((r) => setImmediate(r));
  assert.equal(ui.snapshots.at(-1).bookmarks.server, 'running');
  assert.equal(h.calls.serve, 1);
  await ui.close();
  global.hecaton.serviceChannel = () => ({ connect: async () => { throw Object.assign(new Error('denied'), { code: 'permission_denied' }); } });
  const denied = h.ui();
  await denied.request();
  assert.equal(denied.errors.at(-1), 'permission_denied');
  assert.equal(h.calls.serve, 1);
  await h.core.shutdown();
});
