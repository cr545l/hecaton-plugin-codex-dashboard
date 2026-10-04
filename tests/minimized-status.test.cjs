const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer } = require('../lib/render');
const { stripAnsi, stringWidth } = require('../lib/text');
const i18n = require('../lib/i18n');

function harness(cols = 80) {
  let tooltip = '';
  global.hecaton = { window: { set_tooltip: async ({ text }) => { tooltip = text; } } };
  const renderer = createRenderer({ initialCols: cols, initialRows: 1 });
  const state = {
    data: { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 } },
    bookmarks: { enabled: true, port: 9219, hooks: 'installed', runtime: { server: 'running' } },
    notifications: { enabled: true, runtime: {} },
  };
  function render() {
    let output = '';
    const original = process.stdout.write;
    process.stdout.write = (chunk) => { output += chunk; return true; };
    try { renderer.renderMinimized(state); } finally { process.stdout.write = original; }
    return stripAnsi(output.split('\x1b[1;1H').at(-1));
  }
  return { state, renderer, render, tooltip: () => tooltip };
}

test('server failure precedes cached usage and exposes the port and reason on hover', () => {
  const h = harness();
  h.state.bookmarks.runtime = { server: 'failed', serverError: 'EADDRINUSE' };
  assert.match(h.render(), /^! Hook server failed :9219.*25\.0%/);
  h.renderer.updateMinimizedTooltip(2, 1);
  assert.match(h.tooltip(), /9219/);
  assert.match(h.tooltip(), /EADDRINUSE/);
  h.state.bookmarks.runtime = { server: 'running' };
  assert.doesNotMatch(h.render(), /failed/);
  assert.equal(h.tooltip(), '');
  h.renderer.updateMinimizedTooltip(2, 1);
  assert.match(h.tooltip(), /Resets/);
});

test('multiple issues show a count and full details; disabled features do not warn', () => {
  const h = harness();
  h.state.bookmarks.runtime = { server: 'failed', serverError: 'busy', unavailable: 'access_denied' };
  h.state.notifications.runtime.error = 'access_denied';
  assert.match(h.render(), /\(\+2\)/);
  h.renderer.updateMinimizedTooltip(2, 1);
  assert.match(h.tooltip(), /Notifications blocked/);
  assert.match(h.tooltip(), /terminal status permission denied/);
  h.state.bookmarks.enabled = false;
  h.state.notifications.enabled = false;
  assert.doesNotMatch(h.render(), /!|failed|error/);
});

test('scan and settings failures stay visible even with usage data', () => {
  const h = harness();
  h.state.error = { key: 'status.scanFailed', args: { error: 'unreadable' } };
  assert.match(h.render(), /^! Session scan failed/);
  h.renderer.updateMinimizedTooltip(2, 1);
  assert.match(h.tooltip(), /unreadable/);
  h.state.error = null;
  h.state.status = { key: 'status.configNotSaved' };
  assert.match(h.render(), /^! Settings action failed/);
  h.state.status = null;
  h.state.deniedPermissions = ['fs_read'];
  assert.match(h.render(), /^! Permission blocked/);
});

test('Korean warnings fit narrow bars while hover preserves complete details', () => {
  i18n.setLocale('ko');
  try {
    const h = harness(24);
    h.state.bookmarks.runtime = { server: 'failed', serverError: 'EADDRINUSE' };
    const line = h.render();
    assert.match(line, /^! 훅 서버 실패 :9219/);
    assert.equal(stringWidth(line), 24);
    assert.ok(!line.includes('\n'));
    h.renderer.updateMinimizedTooltip(2, 1);
    assert.match(h.tooltip(), /EADDRINUSE/);
    h.state.data = null;
    assert.match(h.render(), /^! 훅 서버 실패/);
  } finally { i18n.setLocale('en'); }
});
