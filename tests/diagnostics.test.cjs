'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticLog } = require('../lib/diagnostics');
const { createHookService } = require('../lib/hook-service');
const { createRenderer } = require('../lib/render');
const { diagnosticLines } = require('../lib/diagnostic-view');
const { stripAnsi, stringWidth } = require('../lib/text');
const i18n = require('../lib/i18n');

function storage(content) {
  const files = new Map(content ? [['/data/hook-diagnostics.json', content]] : []);
  const writes = [];
  global.hecaton = { fs: {
    read_file: async ({ path }) => files.has(path) ? { ok: true, content: files.get(path) } : { ok: false, error_code: 'not_found' },
    mkdir: async () => ({ ok: true }),
    write_file: async ({ path, content }) => { files.set(path, content); writes.push(content); return { ok: true }; },
  } };
  return { files, writes };
}

test('bounded diagnostics persist and load across service restarts without losing new records', async () => {
  const store = storage();
  const path = '/data/hook-diagnostics.json';
  const first = createDiagnosticLog({ path, limit: 3 });
  for (let i = 0; i < 5; i++) first.record('error', 'terminal.not_found', { source_id: i });
  await first.close();
  assert.deepEqual(JSON.parse(store.files.get(path)).entries.map(e => e.details.source_id), [2, 3, 4]);
  const next = createDiagnosticLog({ path, limit: 3 });
  next.record('info', 'service.started');
  await next.load();
  assert.equal(next.snapshot().entries.length, 3);
  assert.equal(next.snapshot().entries[0].details.source_id, 3);
  assert.equal(next.snapshot().entries.at(-1).stage, 'service.started');
  await next.close();
});

test('denied writes keep diagnostics visible in memory and recover on explicit flush', async () => {
  storage();
  let allowed = false;
  global.hecaton.fs.write_file = async () => allowed ? { ok: true } : { ok: false, error_code: 'access_denied', error: 'Write denied' };
  const log = createDiagnosticLog({ path: '/data/hook-diagnostics.json' });
  log.record('error', 'bookmark.failed', { error: { code: 'not_found' } });
  await log.flush();
  assert.equal(log.snapshot().persistenceError.code, 'access_denied');
  assert.equal(log.snapshot().entries.length, 1);
  allowed = true;
  await log.flush();
  assert.equal(log.snapshot().persistenceError, null);
  await log.close();
});

test('a corrupt prior log remains intact while new failures remain inspectable', async () => {
  const store = storage('{broken');
  const log = createDiagnosticLog({ path: '/data/hook-diagnostics.json' });
  await log.load();
  log.record('error', 'terminal.ambiguous', { source_id: 4901 });
  await log.close();
  assert.ok(log.snapshot().persistenceError);
  assert.equal(log.snapshot().entries.length, 1);
  assert.equal(store.writes.length, 0);
  assert.equal(store.files.get('/data/hook-diagnostics.json'), '{broken');
});

test('writes are serialized and an event received during a write is saved on the next flush', async () => {
  const store = storage();
  let release, started;
  const ready = new Promise(r => { started = r; });
  const gate = new Promise(r => { release = r; });
  let active = 0;
  global.hecaton.fs.write_file = async ({ content }) => {
    assert.equal(++active, 1);
    started();
    await gate;
    store.writes.push(content);
    active--;
    return { ok: true };
  };
  const log = createDiagnosticLog({ path: '/data/hook-diagnostics.json' });
  log.record('info', 'first');
  const pending = log.flush();
  await ready;
  log.record('error', 'second');
  const again = log.flush();
  release();
  await Promise.all([pending, again]);
  assert.deepEqual(JSON.parse(store.writes.at(-1)).entries.map(e => e.stage), ['first', 'second']);
  await log.close();
});

test('large logs are bounded and terminal titles cannot inject control sequences', async () => {
  const log = createDiagnosticLog({ maxChars: 4000 });
  for (let i = 0; i < 100; i++) log.record('warn', 'terminal.cwd_fallback', { title: '\x1b[2Junsafe\n\x1b]0;title\x07', cwd: 'x'.repeat(10000) });
  const snapshot = log.snapshot();
  assert.ok(JSON.stringify(snapshot.entries).length < 4100);
  assert.ok(snapshot.entries.length > 0);
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(snapshot.entries[0].details.title), false);
  assert.ok(snapshot.entries[0].details.cwd.length <= 1024);
  await log.close();
});

test('ambiguous hooks retain source id, session, relay PID and real candidate metadata without the reply', async () => {
  global.hecaton = {
    permissions: { query: async () => ({ state: 'granted' }) },
    terminal: { list: async () => ({ ok: true, terminals: [
      { id: 3005, title: 'Old shell', cwd: 'C:/work' },
      { id: 4818, title: 'Codex shell', cwd: 'C:/work' },
      { id: 99, title: 'Dashboard', cwd: 'C:/work', plugin_only: true },
    ] }) },
  };
  const core = createHookService({ config: {} });
  await core.onHttpRequest({ body: JSON.stringify({ client: 'codex', event: 'Stop', terminal_id: '4901',
    relay: { pid: 123, parent_pid: 456 }, hook: { cwd: 'C:\\work', session_id: 'session-1',
      turn_id: 'turn-1', last_assistant_message: 'PRIVATE_REPLY', prompt: 'PRIVATE_PROMPT' } }) });
  const entries = core.snapshot().diagnostics.entries;
  const received = entries.find(e => e.stage === 'hook.received');
  const failure = entries.find(e => e.stage === 'terminal.ambiguous');
  assert.equal(failure.details.trace, received.id);
  assert.equal(failure.details.source_id, '4901');
  assert.equal(failure.details.session_id, 'session-1');
  assert.equal(failure.details.relay_parent_pid, 456);
  assert.deepEqual(failure.details.candidates.map(t => t.id), [3005, 4818]);
  assert.equal(failure.details.candidates[1].title, 'Codex shell');
  assert.equal(failure.details.open_count, 3);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/);
  await core.shutdown();
});

test('bookmark and notification failures preserve the host error code, message and target', async () => {
  global.hecaton = {
    permissions: { query: async () => ({ state: 'granted' }) },
    terminal: {
      list: async () => ({ terminals: [{ id: 42, cwd: '/work' }] }),
      get_cells: async () => ({ ok: false, error_code: 'not_found', error: 'Terminal disappeared' }),
      add_bookmark: async () => ({ ok: false, error_code: 'not_found', error: 'Terminal not found' }),
    },
    notify: { send: async () => { throw Object.assign(new Error('UI detached'), { code: 'no_terminal' }); } },
  };
  const core = createHookService({ config: {} });
  await core.onHttpRequest({ body: JSON.stringify({ client: 'codex', event: 'Stop', terminal_id: '42' }) });
  const entries = core.snapshot().diagnostics.entries;
  for (const stage of ['bookmark.screen_unavailable', 'bookmark.failed', 'notification.failed']) {
    const entry = entries.find(e => e.stage === stage);
    assert.equal(entry.details.terminal_id, 42);
    assert.ok(entry.details.error.code);
    assert.ok(entry.details.error.message);
  }
  assert.equal(entries.find(e => e.stage === 'terminal.resolved').details.via, 'hook');
  await core.shutdown();
});

test('in-plugin log view wraps candidate details, filters failures and pages without overflowing', () => {
  const entries = [
    { id: 'first', at: '2026-10-24T00:00:00Z', level: 'error', stage: 'terminal.ambiguous',
      details: { source_id: '4901', candidates: [{ id: 4818, title: '작업 터미널 😀', cwd: 'C:/a/long/project/path' }] } },
    { id: 'second', at: '2026-10-24T00:01:00Z', level: 'info', stage: 'hook.received', details: {} },
  ];
  const all = diagnosticLines(entries, 32);
  const errors = diagnosticLines(entries, 32, true);
  assert.match(all.join(''), /hook.received/);
  assert.doesNotMatch(errors.join(''), /hook.received/);
  assert.match(errors.join(''), /4818/);
  assert.ok(errors.every(line => stringWidth(line) <= 32));
  global.hecaton = { window: { set_tooltip: async () => {} } };
  const renderer = createRenderer({ initialCols: 80, initialRows: 12 });
  const state = { showDiagnostics: true, diagnostics: { entries, path: '/data/hook-diagnostics.json' } };
  function render() {
    let output = '';
    const original = process.stdout.write;
    process.stdout.write = chunk => { output += chunk; return true; };
    try { renderer.render(state); } finally { process.stdout.write = original; }
    return output;
  }
  const first = render();
  assert.match(stripAnsi(first), /Hook diagnostics/);
  assert.match(stripAnsi(first), /hook.received/);
  assert.equal(renderer.findActionAt(2, 12), 'toggle_diagnostics');
  renderer.scrollDiagnostics(1, true);
  assert.notEqual(render(), first);
  renderer.scrollDiagnostics(-Infinity);
  assert.equal(render(), first);
  i18n.setLocale('ko');
  try {
    state.logErrorsOnly = true;
    state.diagnostics.persistenceError = { code: 'access_denied' };
    renderer.setTerminalSize(32, 12);
    const narrow = render();
    assert.match(stripAnsi(narrow), /훅 진단 로그/);
    const rows = narrow.split(/\x1b\[\d+;1H/).slice(1);
    assert.equal(rows.length, 12);
    assert.ok(rows.every(row => stringWidth(stripAnsi(row)) <= 32));
  } finally { i18n.setLocale('en'); }
});
