'use strict';
// node --test tests/turn-bookmarks.test.cjs
// 턴 북마크의 세 부분을 실제 Hecaton 없이 검증한다: hooks.json 병합, 중계기 프로세스, 이벤트→북마크.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const codexHooks = require('../lib/codex-hooks');
const { createTurnBookmarks, excerpt } = require('../lib/turn-bookmarks');

test('merge keeps foreign hooks, adds ours once and replaces a moved install', () => {
  const tldraw = { matcher: 'tldraw-offline', hooks: [{ type: 'command', command: "sh 'inject.sh' SubagentStart" }] };
  const userStop = { hooks: [{ type: 'command', command: 'echo done' }] };
  const doc = { other: true, hooks: { SubagentStart: [tldraw], Stop: [userStop] } };
  assert.equal(codexHooks.inspect(doc, '/old'), 'missing');

  const once = codexHooks.merge(doc, '/old');
  assert.equal(codexHooks.inspect(once, '/old'), 'installed');
  assert.equal(once.other, true);
  assert.deepEqual(once.hooks.SubagentStart, [tldraw]);
  assert.deepEqual(once.hooks.Stop[0], userStop, "the user's own Stop hook stays first");
  for (const event of codexHooks.EVENTS) {
    const ours = once.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes(codexHooks.RELAY_FILE));
    assert.equal(ours.length, 1, event);
    assert.equal(ours[0].command, `node "/old/lib/${codexHooks.RELAY_FILE}" ${event} ${codexHooks.PORT}`);
  }
  assert.deepEqual(codexHooks.merge(once, '/old'), once, 'merging again changes nothing');

  // 플러그인 폴더가 바뀌면 "오래됨" → 다시 설치하면 새 경로 하나만 남는다.
  assert.equal(codexHooks.inspect(once, 'C:\\new'), 'stale');
  const moved = codexHooks.merge(once, 'C:\\new');
  assert.equal(codexHooks.inspect(moved, 'C:\\new'), 'installed');
  assert.equal(JSON.stringify(moved).includes('/old/'), false);
});

function runRelay(port, stdin, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, 'lib', codexHooks.RELAY_FILE), 'Stop', String(port)],
      { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

test('relay forwards the hook input with the terminal id and prints nothing', async () => {
  let received = null;
  // 호스트 서버처럼 답하지 않는다 — 중계기는 응답을 기다리지 않고 끝나야 한다.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { received = { path: req.url, body: JSON.parse(body) }; });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hook = { session_id: 's1', model: 'gpt-x', last_assistant_message: 'x'.repeat(5000), transcript_path: '/secret' };
  const result = await runRelay(port, JSON.stringify(hook), { CONSOLE_TERMINAL_ID: '42' });
  server.close();
  server.closeAllConnections();
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'Codex reads Stop hook stdout as a decision');
  assert.ok(result.ms < 3000, `took ${result.ms}ms`);
  assert.equal(received.path, '/hook');
  assert.equal(received.body.client, 'codex');
  assert.equal(received.body.event, 'Stop');
  assert.equal(received.body.terminal_id, '42');
  assert.equal(received.body.hook.model, 'gpt-x');
  assert.equal(received.body.hook.last_assistant_message.length, 2000);
  assert.equal('transcript_path' in received.body.hook, false);
});

test('relay exits quietly when the dashboard is not running', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  await new Promise((r) => blocker.close(r)); // 아무도 듣지 않는 포트
  const result = await runRelay(port, '{}', { CONSOLE_TERMINAL_ID: '1' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

function mockHost({ addBookmark } = {}) {
  const calls = [];
  global.hecaton = {
    terminal: addBookmark === null ? {} : {
      add_bookmark: async (params) => { calls.push(params); return addBookmark ? addBookmark(params) : { ok: true, bookmark_id: calls.length, created: true }; },
    },
  };
  return calls;
}

test('Stop and PermissionRequest bookmark the hooked terminal with a detailed comment', async () => {
  const calls = mockHost();
  const tb = createTurnBookmarks({ isEnabled: () => true });
  await tb.handle({ client: 'codex', event: 'UserPromptSubmit', terminal_id: '42' });
  await tb.handle({ client: 'codex', event: 'PermissionRequest', terminal_id: '42', hook: { tool_name: 'shell' } });
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '42',
    hook: { model: 'gpt-x', last_assistant_message: '```\ncode\n```\nFixed the bug.\n\nRan tests.\nAll green.\nMore.' } });
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '42', hook: {} }); // 중복
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '', hook: {} });   // Hecaton 밖
  await tb.handle({ client: 'claude', event: 'Stop', terminal_id: '42' });          // 다른 클라이언트

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.terminal_id), [42, 42]);
  assert.match(calls[0].label, /^Codex · needs approval \d\d:\d\d$/);
  assert.match(calls[0].comment, /Tool: shell/);
  assert.match(calls[1].label, /^Codex · response complete \d\d:\d\d$/);
  const lines = calls[1].comment.split('\n');
  assert.match(lines[0], /^response complete at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(lines[1], 'Model: gpt-x');
  assert.match(lines[2], /^Turn time: \d+s$/);
  assert.deepEqual(lines.slice(4), ['Fixed the bug.', 'Ran tests.', 'All green.', '…']);
  assert.equal(tb.state.count, 2);
  assert.equal(tb.state.last.key, 'Stop');
});

test('a refused or missing API turns bookmarks off instead of retrying', async () => {
  let calls = mockHost({ addBookmark: () => ({ ok: false, error_code: 'access_denied' }) });
  let tb = createTurnBookmarks({ isEnabled: () => true });
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '7' });
  await tb.handle({ client: 'codex', event: 'PermissionRequest', terminal_id: '7' });
  assert.equal(calls.length, 1, 'one refusal is not re-asked');
  assert.equal(tb.state.unavailable, 'access_denied');

  mockHost({ addBookmark: null });
  tb = createTurnBookmarks({ isEnabled: () => true });
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '7' });
  assert.equal(tb.state.unavailable, 'unsupported');

  calls = mockHost();
  tb = createTurnBookmarks({ isEnabled: () => false });
  await tb.handle({ client: 'codex', event: 'Stop', terminal_id: '7' });
  assert.equal(calls.length, 0, 'the toggle is respected');
});

test('excerpt skips blank lines and code fences and caps the length', () => {
  assert.equal(excerpt(''), '');
  assert.equal(excerpt('a\n\n```js\nb\n```\nc'), 'a\nc');
  assert.equal(excerpt('y'.repeat(400)).length, 300);
});
