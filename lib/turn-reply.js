'use strict';

const i18n = require('./i18n');

const MESSAGE_RE = /^ {0,1}• /;
const PROMPT_RE = /^ {0,1}[›❯]+(?: |$)/;
const COMPLETION_RE = /^\s*(?:─+\s*)?(?:Worked for <?\d|(?:\w+ \d{1,2}(?:, \d{4})? at )?\d{1,2}:\d{2}(?: ?[AP]M)?(?:\s|$)|Local tools:|Inference:|WebSocket:|Streams?:|Responses API )/;
const COMMENT_MAX_BYTES = 4096;

// get_cells rows contain 12-byte cells, beginning with a UTF-32 LE code point.
// Flag 0x80 in byte 10 marks the continuation of a double-width glyph.
function decodeRow(entry, cols) {
  const data = typeof entry === 'string' ? entry : entry?.data;
  if (!data) return '';
  const raw = atob(data);
  let text = '';
  for (let c = 0; c < cols && c * 12 + 12 <= raw.length; c++) {
    const offset = c * 12;
    if (raw.charCodeAt(offset + 10) & 0x80) continue;
    const cp = (raw.charCodeAt(offset) | (raw.charCodeAt(offset + 1) << 8)
      | (raw.charCodeAt(offset + 2) << 16) | (raw.charCodeAt(offset + 3) << 24)) >>> 0;
    text += cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
  }
  return text.trimEnd();
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
}

function replyText(rows) {
  return cleanText(rows.map((line, index) => index === 0 && MESSAGE_RE.test(line)
    ? line.replace(MESSAGE_RE, '') : line.replace(/^ {2}/, '')).join('\n'));
}

// Compare textual anchors, ignoring Markdown presentation and terminal wrapping.
// This prevents bookmarking a previous reply or a tool cell while Stop is redrawn.
function comparable(text) {
  return cleanText(text).replace(/^\s*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\p{N}]/gu, '');
}

function matchesReply(reply, hook, clipped) {
  const expected = comparable(hook.last_assistant_message);
  const actual = comparable(reply);
  if (!expected) return true;
  if (!actual) return false;
  const tail = comparable(hook.last_assistant_message_tail) || expected;
  const size = Math.min(80, actual.length, tail.length);
  if (!actual.endsWith(tail.slice(-size))) return false;
  return clipped || actual.startsWith(expected.slice(0, Math.min(80, actual.length, expected.length)));
}

// Codex indents reply continuation rows by two cells and starts a message with •.
// The composer uses ›; completion metadata may follow the reply (new Codex) or
// precede it in a ruled separator (older Codex). Neither belongs to the range.
function locateTurn(lines, cursorY, hook = {}) {
  if (!Number.isInteger(cursorY) || cursorY < 0 || cursorY >= lines.length) return null;
  let prompt = -1;
  // A hidden/unfocused Codex cursor can be parked above the composer. Locate
  // the last prompt from the screen itself; cursorY is only the API's offset base.
  for (let r = lines.length - 1; r >= 0; r--) {
    if (PROMPT_RE.test(lines[r])) { prompt = r; break; }
  }
  if (prompt < 0) return null;
  let end = prompt - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  // Completion metrics can wrap onto otherwise unrecognisable continuation rows.
  // Strip the entire trailing metadata block, rather than only its first row.
  let metadata = -1;
  for (let r = end; r >= 0 && !MESSAGE_RE.test(lines[r]) && !PROMPT_RE.test(lines[r]); r--) {
    if (COMPLETION_RE.test(lines[r])) metadata = r;
  }
  if (metadata >= 0) end = metadata - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return { settled: false };
  let start = end;
  let clipped = true;
  for (; start >= 0; start--) {
    if (MESSAGE_RE.test(lines[start])) { clipped = false; break; }
    if (PROMPT_RE.test(lines[start]) || COMPLETION_RE.test(lines[start])) return { settled: false };
  }
  start = Math.max(0, start);
  const reply = replyText(lines.slice(start, end + 1));
  if (!reply || !matchesReply(reply, hook, clipped)) return { settled: false };
  if (!hook.last_assistant_message && /esc to interrupt|running (?:Stop )?hooks/i.test(reply)) return { settled: false };
  return { settled: true, start, end, reply, clipped };
}

function utf8Length(ch) {
  const cp = ch.codePointAt(0);
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

function commentWithReply(comment, reply, clipped = false) {
  reply = cleanText(reply);
  const text = reply ? comment + '\n\n' + i18n.t('bookmark.comment.reply') + '\n' + (clipped ? '…\n' : '') + reply : comment;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    bytes += utf8Length(ch);
    if (bytes > COMMENT_MAX_BYTES - 3) return out + '…';
    out += ch;
  }
  return out;
}

module.exports = { decodeRow, locateTurn, commentWithReply };
