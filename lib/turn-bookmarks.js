'use strict';
// lib/turn-bookmarks.js — Codex 턴 경계를 해당 터미널의 스크롤백에 북마크로 남긴다 (호스트 API 1.21)
//
// 흐름: Codex 훅(~/.codex/hooks.json) → lib/codex-hook-relay.js → 127.0.0.1:PORT/hook →
//       http_request_received → 여기서 terminal.add_bookmark.
// 호스트는 호출 순간 그 터미널의 커서 행에 북마크를 다는데, 훅이 도는 시점의 커서는 Codex 출력이
// 멈춘 자리라 "여기서 응답이 끝났다"를 가리킨다. 라벨은 칩에 보이는 한 줄, 코멘트는 hover 로 보는
// 상세(시각·모델·작업 시간·마지막 응답 앞부분)다.

const i18n = require('./i18n');
const hooks = require('./codex-hooks');
const permissions = require('./permissions');

// 같은 터미널의 같은 이벤트가 이 시간 안에 또 오면 하나로 본다.
const DEDUPE_MS = 5000;
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 300;
const MESSAGE_KEY = {
  Stop: 'bookmark.message.Stop',
  PermissionRequest: 'bookmark.message.PermissionRequest',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTurnDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return i18n.t('time.hours', { value: h }) + i18n.t('time.join') + i18n.t('time.minutes', { value: m });
  if (m > 0) return i18n.t('time.minutes', { value: m }) + i18n.t('time.join') + i18n.t('time.seconds', { value: s });
  return i18n.t('time.seconds', { value: s });
}

// 마지막 응답의 앞 몇 줄. 빈 줄과 코드 블록(펜스 안쪽 전체)은 건너뛰어 읽을 만한 문장이 먼저 오게 한다.
function excerpt(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let inFence = false;
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      return false;
    }
    return !inFence && l.trim();
  });
  let out = lines.slice(0, EXCERPT_LINES).join('\n');
  if (out.length > EXCERPT_CHARS) out = out.slice(0, EXCERPT_CHARS - 1) + '…';
  else if (lines.length > EXCERPT_LINES) out += '\n…';
  return out;
}

function createTurnBookmarks({ serverIdFile, isEnabled, onChange, notifications }) {
  const state = {
    server: 'stopped',          // stopped | running | failed
    serverError: null,
    unavailable: null,          // null | 'unsupported' | 'access_denied'
    lastError: null,
    last: null,                 // { terminalId, key, at }
    count: 0,
  };
  let serverId = null;
  let disposed = false;
  const turnStartedAt = new Map();
  const lastMark = new Map();

  const changed = () => { try { onChange && onChange(); } catch { /* ignore */ } };

  async function rememberServer(id) {
    if (!serverIdFile) return;
    try {
      await hecaton.fs.write_file({ path: serverIdFile, content: id === null ? '' : String(id) });
    } catch { /* best effort */ }
  }

  // 호스트가 소켓을 쥐고 있어서, 플러그인이 정리 없이 죽으면(창 닫기·리로드·크래시) 이전
  // 리스너가 남는다. 같은 포트에 둘이 붙으면 Windows 는 죽은 쪽으로 요청을 보내 훅이 조용히
  // 사라진다 — 시작할 때 지난 server_id 를 회수한다(Claude 대시보드와 같은 처리).
  async function reclaimPreviousServer() {
    if (!serverIdFile) return;
    try {
      const r = await hecaton.fs.read_file({ path: serverIdFile });
      const prev = r && r.content ? String(r.content).trim() : '';
      if (!prev) return;
      const asNum = Number(prev);
      await hecaton.web.stop({ server_id: Number.isFinite(asNum) ? asNum : prev }).catch(() => null);
    } catch { /* nothing to reclaim */ }
  }

  async function start() {
    if (state.server === 'running' || disposed) return;
    await reclaimPreviousServer();
    let result = null;
    try {
      result = await hecaton.web.serve({ port: hooks.PORT, host: '127.0.0.1' });
    } catch (e) {
      result = { ok: false, error: (e && e.message) || String(e), error_code: e && e.code };
    }
    if (disposed) {
      if (result && result.ok) await hecaton.web.stop({ server_id: result.server_id }).catch(() => null);
      return;
    }
    if (!result || !result.ok) {
      state.server = 'failed';
      state.serverError = permissions.isDenied(result) ? 'access_denied' : (result && (result.error_code || result.error)) || 'unknown';
      changed();
      return;
    }
    serverId = result.server_id;
    state.server = 'running';
    state.serverError = null;
    await rememberServer(serverId);
    await hecaton.web.set_http({
      server_id: serverId,
      content_type: 'application/json',
      body: JSON.stringify({ status: 'ok', message: 'Codex Dashboard Hook Server' }),
    }).catch(() => null);
    changed();
  }

  async function stop() {
    if (serverId !== null) {
      const id = serverId;
      serverId = null;
      await hecaton.web.stop({ server_id: id }).catch(() => null);
      await rememberServer(null);
    }
    state.server = 'stopped';
    changed();
  }

  async function dispose() {
    disposed = true;
    await stop();
  }

  function bookmarkComment(terminalId, key, hook) {
    const d = new Date();
    const lines = [i18n.t('bookmark.comment.when', {
      message: i18n.t(MESSAGE_KEY[key]),
      time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    })];
    if (hook.model) lines.push(i18n.t('bookmark.comment.model', { model: hook.model }));
    const started = turnStartedAt.get(terminalId);
    if (started) lines.push(i18n.t('bookmark.comment.turn', { duration: formatTurnDuration(Date.now() - started) }));
    if (key === 'PermissionRequest' && hook.tool_name) {
      lines.push(i18n.t('bookmark.comment.tool', { tool: hook.tool_name }));
    }
    const said = excerpt(hook.last_assistant_message);
    if (said) lines.push('', said);
    return lines.join('\n');
  }

  async function addBookmark(terminalId, key, hook) {
    if (!isEnabled() || state.unavailable || !terminalId) return;
    const mapKey = `${terminalId}:${key}`;
    const now = Date.now();
    if (now - (lastMark.get(mapKey) || 0) < DEDUPE_MS) return;
    lastMark.set(mapKey, now);
    // 구버전 호스트에는 메서드 자체가 없다 — 러너가 호스트의 메서드 표로 API 를 만든다.
    if (typeof (hecaton.terminal && hecaton.terminal.add_bookmark) !== 'function') {
      state.unavailable = 'unsupported';
      changed();
      return;
    }
    const d = new Date();
    try {
      const r = await hecaton.terminal.add_bookmark({
        terminal_id: terminalId,
        label: i18n.t('bookmark.label', { message: i18n.t(MESSAGE_KEY[key]), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }),
        comment: bookmarkComment(terminalId, key, hook),
      });
      if (r && r.ok === false) {
        // 배지와 같은 terminal_status 권한이다. 거부는 호스트가 저장하므로 다시 묻지 않는다.
        if (r.error_code === 'access_denied') state.unavailable = 'access_denied';
        state.lastError = r.error_code || r.error || 'unknown';
      } else {
        state.lastError = null;
        state.count++;
        state.last = { terminalId, key, at: now };
      }
    } catch (e) {
      state.lastError = (e && e.message) || String(e);
    }
    changed();
  }

  async function handle(data) {
    if (!data || typeof data !== 'object' || data.client !== 'codex') return;
    const terminalId = parseInt(data.terminal_id, 10);
    if (!Number.isFinite(terminalId) || terminalId <= 0) return; // Hecaton 밖에서 돈 Codex
    const hook = data.hook && typeof data.hook === 'object' ? data.hook : {};
    switch (data.event) {
      case 'UserPromptSubmit':
        turnStartedAt.set(terminalId, Date.now());
        break;
      case 'PermissionRequest':
        await addBookmark(terminalId, 'PermissionRequest', hook);
        if (notifications) await notifications.send(terminalId, 'PermissionRequest', hook);
        break;
      case 'Stop':
        await addBookmark(terminalId, 'Stop', hook);
        turnStartedAt.delete(terminalId);
        if (notifications) await notifications.send(terminalId, 'Stop', hook);
        break;
      case 'SessionEnd':
        turnStartedAt.delete(terminalId);
        break;
      default:
        break;
    }
  }

  function onHttpRequest(params) {
    if (!params || (serverId !== null && params.server_id !== undefined && String(params.server_id) !== String(serverId))) return;
    if (!params.body) return;
    let data;
    try { data = JSON.parse(params.body); } catch { return; }
    handle(data);
  }

  return { state, start, stop, dispose, onHttpRequest, handle };
}

module.exports = { createTurnBookmarks, excerpt, formatTurnDuration };
