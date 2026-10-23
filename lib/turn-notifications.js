'use strict';

const i18n = require('./i18n');
const permissions = require('./permissions');
const { errorDetails } = require('./diagnostics');

// Plain-text preview, not a generated summary. Never include fenced tool/code output.
function preview(value) {
  if (typeof value !== 'string') return '';
  let fence = null;
  const lines = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).filter((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  });
  const text = lines.map((line) => line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`_~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
  ).join(' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > 180 ? chars.slice(0, 179).join('') + '…' : text;
}

function createTurnNotifications({ isEnabled, onChange, deliver, log = () => {} }) {
  const state = { error: null };
  const lastSent = new Map();
  const changed = () => { if (onChange) onChange(); };

  async function prepare() {
    if (!isEnabled()) return false;
    const allowed = await permissions.ensure('notification');
    state.error = allowed ? null : 'access_denied';
    changed();
    return allowed;
  }

  async function send(terminalId, event, hook = {}, context = {}) {
    const details = { ...context, terminal_id: terminalId, event };
    if (!isEnabled() || state.error === 'access_denied') {
      log('info', 'notification.skipped', { ...details, reason: !isEnabled() ? 'disabled' : state.error });
      return;
    }
    const key = `${terminalId}:${event}`;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < 5000) {
      log('info', 'notification.skipped', { ...details, reason: 'duplicate' });
      return;
    }
    lastSent.set(key, now);
    try {
      if (!await prepare()) {
        log('error', 'notification.failed', { ...details, error: { code: 'access_denied' } });
        return;
      }
      if (typeof hecaton.notify?.send !== 'function') {
        state.error = 'unsupported';
        log('error', 'notification.failed', { ...details, error: { code: 'unsupported' } });
      } else {
        const detail = preview(event === 'Stop' ? hook.last_assistant_message : hook.tool_name);
        const message = i18n.t('bookmark.message.' + event) + (detail ? ' — ' + detail : '');
        const payload = {
          terminal_id: terminalId,
          title: i18n.t('notification.title'),
          body: i18n.t('notification.body', {
            terminal: terminalId, message,
          }),
        };
        const result = await (deliver ? deliver(payload, details) : hecaton.notify.send(payload));
        state.error = result?.ok === false ? result.error_code || result.error || 'unknown' : null;
        log(state.error ? 'error' : 'info', state.error ? 'notification.failed' : 'notification.sent',
          { ...details, api: 'notify.send', ...(state.error ? { error: errorDetails(result) } : {}) });
      }
    } catch (e) {
      state.error = permissions.isDenied(e) ? 'access_denied' : e.message || String(e);
      log('error', 'notification.failed', { ...details, api: 'notify.send', error: errorDetails(e) });
    }
    if (state.error && lastSent.get(key) === now) lastSent.delete(key);
    changed();
  }

  function beginTurn(terminalId) {
    for (const event of ['Stop', 'PermissionRequest']) lastSent.delete(`${terminalId}:${event}`);
  }

  return { state, prepare, send, beginTurn };
}

module.exports = { createTurnNotifications };
