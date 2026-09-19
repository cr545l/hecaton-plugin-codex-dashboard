'use strict';
// lib/text.js — 표시 폭 계산 유틸
//
// 규칙: 모든 패딩/절단은 String.length 가 아니라 "표시 폭"(CJK=2, ANSI=0) 기준.
// 한국어를 켜면 같은 글자 수라도 폭이 두 배가 된다 — 최소화 바(1행 버퍼)는 폭을
// 한 칸이라도 넘기면 오토랩 스크롤로 줄이 통째로 사라지므로 여기를 반드시 통과시킨다.

const SGR_RE = /\x1b\[[0-9;]*m/g;

// East-Asian Wide / 이모지 주요 범위 → 폭 2
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20) return 0;                                   // 제어문자
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||                        // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||                        // CJK Radicals..Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||                        // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||                        // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||                        // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||                        // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||                      // 이모지 블록
    (cp >= 0x20000 && cp <= 0x3fffd)                         // CJK Ext B+
  ) return 2;
  return 1;
}

function stripAnsi(text) {
  return String(text == null ? '' : text).replace(SGR_RE, '');
}

// ANSI 제거 후 표시 폭
function stringWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

// 표시 폭 기준 우측 공백 패딩 (ANSI 포함 문자열 허용)
function padEnd(text, width) {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

// 표시 폭 기준 절단. SGR 시퀀스는 폭에 세지 않고 그대로 보존한다.
// ellipsis 를 주면 넘칠 때 마지막 한 칸을 그 문자로 바꾼다.
function truncate(text, maxWidth, ellipsis) {
  const source = String(text == null ? '' : text);
  if (stringWidth(source) <= maxWidth) return source;
  const mark = ellipsis || '';
  const budget = Math.max(0, maxWidth - stringWidth(mark));
  let out = '';
  let width = 0;
  let i = 0;
  while (i < source.length) {
    if (source[i] === '\x1b') {
      const m = source.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(source.codePointAt(i));
    const cw = charWidth(ch);
    if (width + cw > budget) break;
    out += ch;
    width += cw;
    i += ch.length;
  }
  return out + mark;
}

// 절단 + 패딩 결합 — 고정 폭 칸의 단일 진입점
function fit(text, width, ellipsis) {
  return padEnd(truncate(text, width, ellipsis), width);
}

module.exports = { charWidth, stripAnsi, stringWidth, padEnd, truncate, fit };
