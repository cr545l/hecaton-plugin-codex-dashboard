#!/usr/bin/env node
'use strict';
// lib/codex-hook-relay.js — Codex CLI 훅 → Codex Dashboard 중계기
//
// ~/.codex/hooks.json 이 `node "<이 파일>" <이벤트> <포트>` 로 부른다. Codex 는 훅 입력 JSON 을
// stdin 으로 넘기고, 이 프로세스는 Hecaton 이 셸에 넣어 둔 CONSOLE_TERMINAL_ID 를 물려받는다.
// 그 둘을 묶어 대시보드의 로컬 훅 서버(127.0.0.1)로 POST 한다.
//
// 이 파일은 Hecaton 플러그인 런타임이 아니라 Codex 가 띄우는 평범한 Node 프로세스다 — `hecaton`
// 전역이 없고 의존성도 없다. 셸(cmd/PowerShell/sh)마다 다른 따옴표·환경변수 문법을 피하려고
// curl 한 줄 대신 이 스크립트를 쓴다.
//
// 규칙
//  - **stdout 에 아무것도 쓰지 않는다.** Codex 는 Stop 등의 훅 출력을 판단 결과(JSON)로 읽는다.
//  - 무슨 일이 있어도 빨리, exit 0 으로 끝난다. 대시보드가 꺼져 있어도 Codex 를 막으면 안 된다.
//  - 응답을 기다리지 않는다. 호스트 HTTP 서버는 요청에 답하지 않을 수 있다(Claude 대시보드의
//    curl 이 타임아웃까지 남던 이유) — 요청을 소켓에 넘기면 끝낸다.

const http = require('http');

const event = process.argv[2] || '';
const port = parseInt(process.argv[3] || '9219', 10);
const MAX_INPUT = 256 * 1024;
const MAX_MESSAGE = 2000;

let input = '';
let sent = false;

function pick(hook) {
  // 필요한 필드만 옮긴다 — transcript 경로나 도구 입력 전체를 대시보드에 흘릴 이유가 없다.
  const out = {};
  if (!hook || typeof hook !== 'object') return out;
  for (const key of ['session_id', 'turn_id', 'cwd', 'model', 'permission_mode']) {
    if (typeof hook[key] === 'string') out[key] = hook[key];
  }
  if (typeof hook.last_assistant_message === 'string') {
    out.last_assistant_message = hook.last_assistant_message.slice(0, MAX_MESSAGE);
  }
  if (typeof hook.tool_name === 'string') out.tool_name = hook.tool_name;
  return out;
}

function send() {
  if (sent) return;
  sent = true;
  let hook = null;
  try { hook = input ? JSON.parse(input) : null; } catch { hook = null; }
  const body = JSON.stringify({
    client: 'codex',
    event,
    terminal_id: process.env.CONSOLE_TERMINAL_ID || '',
    hook: pick(hook),
  });
  const done = () => process.exit(0);
  try {
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', done);
    req.setTimeout(1000, done);
    // 요청이 소켓으로 넘어가면 답을 기다리지 않고 끝낸다.
    req.end(body, () => setTimeout(done, 50));
  } catch {
    done();
  }
  setTimeout(done, 1500).unref();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (input.length < MAX_INPUT) input += chunk;
});
process.stdin.on('end', send);
process.stdin.on('error', send);
// stdin 이 닫히지 않는 실행 환경에서도 멈추지 않는다.
setTimeout(send, 800).unref();
