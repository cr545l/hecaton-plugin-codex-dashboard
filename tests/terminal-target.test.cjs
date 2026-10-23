'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalResolver } = require('../lib/terminal-target');
const { createHookService } = require('../lib/hook-service');

function setup(entries) {
  let listed = 0;
  global.hecaton = {
    permissions: { query: async () => ({ state: 'granted' }) },
    terminal: { list: async () => { listed++; return { ok: true, terminals: entries }; } },
  };
  return { resolver: createTerminalResolver(), listed: () => listed };
}

function hook(terminal_id = '4901', cwd = 'C:\\work', session_id = 'session-1') {
  return { client: 'codex', event: 'Stop', terminal_id, hook: { cwd, session_id } };
}

test('live instance id wins over a different cwd and focused unrelated shell', async () => {
  const { resolver } = setup([{ id: 4901, cwd: '/elsewhere' }, { id: 42, cwd: 'C:/work', focused: true }]);
  assert.deepEqual(await resolver.resolve(hook()), { sourceId: 4901, terminalId: 4901, via: 'hook' });
});

test('stale hook ids map to the only matching shell using Windows path comparison', async () => {
  const { resolver } = setup([
    { id: 3005, cwd: 'C:/work', plugin_only: true },
    { id: 4818, cwd: 'c:/WORK/' }, { id: 91, cwd: 'C:/other', focused: true },
  ]);
  assert.deepEqual(await resolver.resolve(hook()), { sourceId: 4901, terminalId: 4818, via: 'cwd' });
});

test('session binding survives cwd changes and extra shells, but is scoped to the source and session', async () => {
  const entries = [{ id: 4818, cwd: 'C:/work' }];
  const { resolver } = setup(entries);
  await resolver.resolve(hook());
  entries.push({ id: 4901, cwd: 'C:/unrelated' }, { id: 42, cwd: 'C:/work' });
  assert.equal((await resolver.resolve(hook('4901', 'C:/changed'))).terminalId, 4818);
  assert.equal((await resolver.resolve(hook('4901', 'C:/work', 'session-2'))).terminalId, 4901);
  assert.equal((await resolver.resolve(hook('42'))).terminalId, 42);
  resolver.forget(hook());
  assert.equal((await resolver.resolve(hook())).terminalId, 4901);
});

test('closed bindings are refreshed and never routed by a stale cache', async () => {
  const entries = [{ id: 4818, cwd: 'C:/work' }];
  const { resolver } = setup(entries);
  await resolver.resolve(hook());
  entries.splice(0, 1, { id: 42, cwd: 'C:/work' });
  assert.equal((await resolver.resolve(hook())).terminalId, 42);
  entries.length = 0;
  assert.equal((await resolver.resolve(hook())).error.key, 'terminal.error.not_found');
});

test('ambiguous cwd, absent cwd and Unix path case differences never guess a target', async () => {
  const { resolver } = setup([{ id: 41, cwd: '/work' }, { id: 42, cwd: '/work', focused: true }]);
  assert.equal((await resolver.resolve(hook('4901', '/work'))).error.key, 'terminal.error.ambiguous');
  for (const cwd of ['', '/WORK', 'work']) {
    assert.equal((await resolver.resolve(hook('4901', cwd))).error.key, 'terminal.error.not_found');
  }
});

test('malformed ids and hooks from outside Hecaton cannot fall back to cwd', async () => {
  const h = setup([{ id: 42, cwd: 'C:/work' }]);
  for (const id of ['', undefined, null, 0, -1, 1.5, '42junk', '42.5', '0x2a', '2147483648', {}, true]) {
    const data = hook();
    data.terminal_id = id;
    assert.equal(await h.resolver.resolve(data), null);
  }
  assert.equal(h.listed(), 0);
});

test('missing API preserves exact ids, while denial, errors and malformed lists fail closed', async () => {
  const { resolver } = setup([]);
  delete global.hecaton.terminal.list;
  assert.equal((await resolver.resolve(hook())).terminalId, 4901);
  global.hecaton.terminal.list = async () => { throw Error('offline'); };
  assert.equal((await resolver.resolve(hook())).error.key, 'terminal.error.unavailable');
  global.hecaton.terminal.list = async () => ({ ok: false, error_code: 'access_denied' });
  assert.equal((await resolver.resolve(hook())).error.key, 'terminal.error.access_denied');
  global.hecaton.terminal.list = async () => ({ ok: true });
  assert.equal((await resolver.resolve(hook())).error.key, 'terminal.error.unavailable');
  global.hecaton.permissions.query = async () => ({ state: 'denied' });
  global.hecaton.terminal.list = async () => { assert.fail('must respect denied permission'); };
  assert.equal((await resolver.resolve(hook())).error.key, 'terminal.error.access_denied');
});

test('HTTP hooks share the resolved id across bookmarks and notifications and recover from ambiguity', async () => {
  const entries = [{ id: 4818, cwd: 'C:/work' }, { id: 42, cwd: 'C:/work' }];
  setup(entries);
  const marks = [], notices = [];
  global.hecaton.terminal.add_bookmark = async p => { marks.push(p); return { ok: true }; };
  global.hecaton.notify = { send: async p => { notices.push(p); return { ok: true }; } };
  const core = createHookService({ config: {} });
  const data = hook();
  const send = () => core.onHttpRequest({ body: JSON.stringify(data) });
  await send();
  assert.equal(core.snapshot().bookmarks.targetError.key, 'terminal.error.ambiguous');
  assert.equal(marks.length + notices.length, 0);
  entries.pop();
  data.event = 'UserPromptSubmit';
  await send();
  data.event = 'PermissionRequest';
  await send();
  data.event = 'Stop';
  await send();
  await send(); // duplicate
  assert.deepEqual(marks.map(p => p.terminal_id), [4818, 4818]);
  assert.deepEqual(notices.map(p => p.terminal_id), [4818, 4818]);
  assert.match(marks[1].comment, /Turn time:/);
  assert.equal(core.snapshot().bookmarks.targetError, null);
  assert.equal(core.snapshot().bookmarks.last.terminalId, 4818);
});

test('slow target resolution preserves prompt and stop order without serializing reply rendering', async () => {
  setup([{ id: 42, cwd: 'C:/work' }]);
  let release;
  const gate = new Promise(r => { release = r; });
  let reads = 0;
  global.hecaton.terminal.list = async () => {
    if (++reads === 1) await gate;
    return { terminals: [{ id: 42, cwd: 'C:/work' }] };
  };
  const marks = [];
  global.hecaton.terminal.add_bookmark = async p => { marks.push(p); return { ok: true }; };
  const core = createHookService({ config: { notifications: false } });
  const send = event => core.onHttpRequest({ body: JSON.stringify({ ...hook(), event }) });
  const prompt = send('UserPromptSubmit');
  const stop = send('Stop');
  release();
  await Promise.all([prompt, stop]);
  assert.equal(marks.length, 1);
  assert.match(marks[0].comment, /Turn time:/);
});
