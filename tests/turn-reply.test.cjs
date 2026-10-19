'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeRow, locateTurn, commentWithReply } = require('../lib/turn-reply');
const { createTurnBookmarks } = require('../lib/turn-bookmarks');
const i18n = require('../lib/i18n');

function screen(lines, cursorY = lines.length - 2, cols = 100) {
  const rows_data = {};
  for (let r = 0; r < lines.length; r++) {
    const raw = Buffer.alloc(cols * 12);
    let c = 0;
    for (const ch of lines[r]) {
      if (c >= cols) break;
      raw.writeUInt32LE(ch.codePointAt(0), c++ * 12);
      if (/[\uac00-\ud7a3\u{1f300}-\u{1faff}]/u.test(ch) && c < cols) raw[c++ * 12 + 10] = 0x80;
    }
    rows_data[r] = raw.toString('base64');
  }
  return { rows: lines.length, cols, cursor_y: cursorY, rows_data };
}

const REPLY = '**Fixed login.**\n\n안녕하세요 😀\n\n```js\n  const ok = true;\n```\n\n[Tests passed.](https://example.com)';
const SETTLED = ['› Fix login', '• I will check.', '• Ran node --test', '  All green.', '',
  '• Fixed login.', '', '  안녕하세요 😀', '', '    const ok = true;', '', '  Tests passed.', '',
  '  Worked for 3s • 10:00 PM', '', '›', '  ? for shortcuts'];

function harness({ cells = () => screen(SETTLED), permission = 'granted' } = {}) {
  const marks = [], notices = [], reads = [], prompts = [];
  global.hecaton = {
    permissions: {
      query: async () => ({ state: permission }),
      request: async (p) => { prompts.push(p); return { granted: true }; },
    },
    terminal: {
      get_cells: async (p) => { reads.push(p); return cells(); },
      add_bookmark: async (p) => { marks.push(p); return { ok: true }; },
    },
  };
  let enabled = true;
  const tb = createTurnBookmarks({ isEnabled: () => enabled,
    notifications: { send: async (...args) => { notices.push(args); } } });
  const event = (event = 'Stop', hook = { last_assistant_message: REPLY }, terminal_id = 42) =>
    tb.handle({ client: 'codex', event, hook, terminal_id });
  return { tb, marks, reads, notices, prompts, event, disable: () => { enabled = false; } };
}

test('terminal rows decode Hangul and emoji without double-width continuation cells', () => {
  const cells = screen(['• 안녕 😀'], 0);
  assert.equal(decodeRow(cells.rows_data[0], cells.cols), '• 안녕 😀');
  assert.equal(decodeRow({ data: cells.rows_data[0] }, cells.cols), '• 안녕 😀');
  const raw = Buffer.alloc(24);
  raw.writeUInt32LE(0xffffffff, 0);
  raw.writeUInt32LE(65, 12);
  assert.equal(decodeRow(raw.toString('base64'), 2), ' A');
});

test('final reply range excludes prompts, commentary, tool output and completion metadata', () => {
  const turn = locateTurn(SETTLED, 15, { last_assistant_message: REPLY });
  assert.deepEqual([turn.start, turn.end, turn.clipped], [5, 11, false]);
  assert.equal(turn.reply, 'Fixed login.\n\n안녕하세요 😀\n\n  const ok = true;\n\nTests passed.');
  const old = ['› Request', '• Ran tests', '─ Worked for 3s ' + '─'.repeat(25),
    '• Done.', '  Tests passed.', '', '›', '  ? for shortcuts'];
  const oldTurn = locateTurn(old, 6, { last_assistant_message: 'Done.\nTests passed.' });
  assert.deepEqual([oldTurn.start, oldTurn.end], [3, 4]);
});

test('clipped replies start at the screen top, and long relayed replies use their real tail', () => {
  const turn = locateTurn(['  Middle of a long reply.', '  The real ending.', '', '›'], 3,
    { last_assistant_message: 'Beginning.\nMiddle of a long reply.\nThe real ending.' });
  assert.deepEqual([turn.start, turn.end, turn.clipped], [0, 1, true]);
  const relayed = locateTurn(['• Beginning.' + 'x'.repeat(85), '  The real ending.', '', '›'], 3,
    { last_assistant_message: 'Beginning.' + 'x'.repeat(16384), last_assistant_message_tail: 'The real ending.' });
  assert.equal(relayed.settled, true);
  assert.equal(locateTurn(['$ ls', 'file.txt'], 1), null);
  assert.equal(locateTurn(['• Old reply.', '', '›'], 2, { last_assistant_message: 'New reply.' }).settled, false);
});

test('wrapped completion metrics are excluded while horizontal rules inside the reply are preserved', () => {
  const lines = ['• First paragraph.', '  ' + '─'.repeat(30), '  Last paragraph.', '',
    '  Worked for 3s • Local tools: 2', '  calls (1.2s) • Inference: 1', '  call (1.5s)', '', '›'];
  const turn = locateTurn(lines, 8, { last_assistant_message: 'First paragraph.\n---\nLast paragraph.' });
  assert.deepEqual([turn.start, turn.end], [0, 2]);
  assert.match(turn.reply, /─{30}/);
});

test('Stop bookmarks the final reply range and preserves code and blank lines in the comment', async () => {
  const h = harness();
  await h.event('UserPromptSubmit');
  await h.event();
  assert.equal(h.marks.length, 1);
  assert.deepEqual([h.marks[0].terminal_id, h.marks[0].row_offset, h.marks[0].lines], [42, -10, 7]);
  assert.match(h.marks[0].comment, /Turn time: \d+s\n\nReply:\nFixed login\.\n\n안녕하세요 😀\n\n  const ok = true;\n\nTests passed\.$/);
  assert.deepEqual(h.reads, [{ terminal_id: 42, since_version: 0 }]);
  assert.equal(h.tb.state.count, 1);
});

test('a hidden cursor parked at the screen top still bookmarks the response, not row zero', async () => {
  const h = harness({ cells: () => screen(SETTLED, 0) });
  await h.event();
  assert.deepEqual([h.marks[0].row_offset, h.marks[0].lines], [5, 7]);
  assert.match(h.marks[0].comment, /Reply:\nFixed login/);
});

test('screen redraw is retried without delaying completion notifications', async () => {
  let first = true;
  const h = harness({ cells: () => {
    if (first) { first = false; return screen(['› Request', '• Working (1s • esc to interrupt)', '', '›', '']); }
    return screen(SETTLED);
  } });
  const pending = h.event();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 1);
  assert.equal(h.marks.length, 0);
  await pending;
  assert.equal(h.reads.length, 2);
  assert.equal(h.marks[0].lines, 7);
});

test('screen denial is remembered and hook text remains available as a cursor bookmark', async () => {
  const h = harness({ cells: () => ({ ok: false, error_code: 'access_denied' }) });
  await h.event();
  await h.event('UserPromptSubmit');
  await h.event();
  assert.equal(h.reads.length, 1);
  assert.equal(h.marks.length, 2);
  assert.ok(h.marks.every(mark => mark.row_offset === undefined));
  assert.match(h.marks[0].comment, /Reply:\n\*\*Fixed login\.\*\*[\s\S]*```js[\s\S]*Tests passed/);
  const denied = harness({ permission: 'denied' });
  await denied.event();
  assert.equal(denied.reads.length, 0);
  assert.equal(denied.prompts.length, 0);
  assert.equal(denied.marks.length, 1);
});

test('a clipped screen reply is identified in the comment', async () => {
  const h = harness({ cells: () => screen(['  Middle.', '  Ending.', '', '›', '']) });
  await h.event('Stop', { last_assistant_message: 'Beginning.\nMiddle.\nEnding.' });
  assert.deepEqual([h.marks[0].row_offset, h.marks[0].lines], [-3, 2]);
  assert.match(h.marks[0].comment, /Reply:\n…\nMiddle\.\nEnding\.$/);
});

test('permission bookmarks do not read the screen and an unrelated screen is not polled', async () => {
  const h = harness({ cells: () => screen(['$ ls', 'file.txt'], 1) });
  await h.event('PermissionRequest', { tool_name: 'shell' });
  assert.equal(h.reads.length, 0);
  await h.event();
  assert.equal(h.reads.length, 1);
  assert.equal(h.marks.length, 2);
  assert.ok(h.marks.every(mark => mark.lines === undefined));
});

test('new prompts, disabling bookmarks and disposal cancel a pending placement', async () => {
  for (const cancel of ['prompt', 'disable', 'dispose', 'sessionEnd']) {
    const h = harness({ cells: () => screen(['• Previous reply.', '', '›', '']) });
    const pending = h.event();
    await new Promise(resolve => setImmediate(resolve));
    if (cancel === 'prompt') await h.event('UserPromptSubmit');
    else if (cancel === 'disable') h.disable();
    else if (cancel === 'dispose') await h.tb.dispose();
    else await h.event('SessionEnd');
    await pending;
    assert.equal(h.marks.length, 0, cancel);
  }
});

test('an unsettled screen has a bounded retry and falls back to the hook body', async () => {
  const h = harness({ cells: () => screen(['• Previous reply.', '', '›', '']) });
  await h.event();
  assert.equal(h.reads.length, 7);
  assert.equal(h.marks.length, 1);
  assert.equal(h.marks[0].row_offset, undefined);
  assert.match(h.marks[0].comment, /Reply:\n\*\*Fixed login\.\*\*/);
});

test('reply comments fit the host UTF-8 byte limit, strip control codes and translate the heading', () => {
  const comment = commentWithReply('Model: gpt-x', '한😀'.repeat(2000));
  assert.ok(Buffer.byteLength(comment) <= 4096);
  assert.match(comment, /…$/);
  assert.equal(comment.includes('\ufffd'), false);
  assert.equal(commentWithReply('Details', '\x1b[31mcode\x1b[0m\x00\n  line'), 'Details\n\nReply:\ncode\n  line');
  i18n.setLocale('ko');
  try { assert.equal(commentWithReply('상세', '본문'), '상세\n\n응답:\n본문'); }
  finally { i18n.setLocale('en'); }
});
