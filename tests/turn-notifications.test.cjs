const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTurnNotifications } = require('../lib/turn-notifications');
const { createTurnBookmarks } = require('../lib/turn-bookmarks');
const i18n = require('../lib/i18n');

function setup({ permission = 'granted', send, bookmarks = false } = {}) {
  const calls = [], requests = [], marks = [];
  global.hecaton = {
    permissions: {
      query: async () => ({ state: permission }),
      request: async (p) => { requests.push(p); return { granted: true }; },
    },
    notify: { send: async (p) => { calls.push(p); return send ? send() : { ok: true }; } },
    terminal: { add_bookmark: async (p) => { marks.push(p); return { ok: false, error_code: 'access_denied' }; } },
  };
  let enabled = true;
  const notifications = createTurnNotifications({ isEnabled: () => enabled });
  const hooks = createTurnBookmarks({ isEnabled: () => bookmarks, notifications });
  const event = (event, terminal_id = '42', hook) => hooks.handle({ client: 'codex', event, terminal_id, hook });
  return { calls, requests, marks, notifications, event, disable: () => { enabled = false; } };
}

test('completion and approval notify independently of bookmarks and suppress duplicates', async () => {
  const h = setup();
  await h.event('UserPromptSubmit');
  await h.event('Stop');
  await h.event('Stop');
  await h.event('PermissionRequest');
  await h.event('SessionEnd');
  await h.event('Stop', '');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].terminal_id, 42);
  assert.match(h.calls[0].body, /response complete/);
  assert.match(h.calls[1].body, /needs approval/);
  h.disable();
  await h.event('Stop', '43');
  assert.equal(h.calls.length, 2);
});

test('bookmark denial does not suppress notifications', async () => {
  const h = setup({ bookmarks: true });
  await h.event('Stop');
  await h.event('PermissionRequest');
  assert.equal(h.marks.length, 1);
  assert.equal(h.calls.length, 2);
});

test('completion includes a short plain-text response and approval includes only the tool', async () => {
  const h = setup();
  await h.event('Stop', '42', { last_assistant_message: '\n```js\nraw output\n```\n**Fixed login.**\n\n- Tests passed.\n[Details](https://example.com)' });
  assert.equal(h.calls[0].body, 'Codex T42 — response complete — Fixed login. Tests passed. Details');
  await h.event('PermissionRequest', '42', { tool_name: 'shell', last_assistant_message: 'Unrelated previous response' });
  assert.equal(h.calls[1].body, 'Codex T42 — needs approval — shell');
});

test('empty, code-only and malformed content fall back; long previews stay bounded', async () => {
  const h = setup();
  for (const [index, value] of [undefined, {}, '   ', '~~~text\noutput\n~~~'].entries()) {
    await h.event('Stop', String(index + 1), { last_assistant_message: value });
    assert.equal(h.calls.at(-1).body, `Codex T${index + 1} — response complete`);
  }
  await h.event('Stop', '99', { last_assistant_message: '😀'.repeat(200) });
  const detail = h.calls.at(-1).body.split(' — ').at(-1);
  assert.equal(Array.from(detail).length, 180);
  assert.ok(detail.endsWith('…'));
});

test('stored notification denial never prompts or sends', async () => {
  const h = setup({ permission: 'denied' });
  await h.notifications.prepare();
  await h.event('Stop');
  assert.equal(h.requests.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.notifications.state.error, 'access_denied');
});

test('permission prompt uses translated reasons and Korean notification text', async () => {
  i18n.setLocale('ko');
  try {
    const h = setup({ permission: 'prompt' });
    await h.event('Stop');
    assert.equal(h.requests[0].permission, 'notification');
    assert.ok(h.requests[0].reason.ko);
    assert.match(h.calls[0].body, /응답 완료/);
  } finally { i18n.setLocale('en'); }
});

test('revoked permission and send failures are reported without breaking bookmarks', async () => {
  const h = setup({ send: () => ({ ok: false, error_code: 'access_denied' }) });
  await h.event('Stop');
  await h.event('PermissionRequest');
  assert.equal(h.calls.length, 1);
  assert.equal(h.notifications.state.error, 'access_denied');
  const failing = setup({ send: () => { throw new Error('offline'); } });
  await failing.event('Stop');
  assert.equal(failing.notifications.state.error, 'offline');
});
