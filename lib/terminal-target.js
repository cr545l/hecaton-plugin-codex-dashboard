'use strict';

const permissions = require('./permissions');
const { errorDetails, hookDetails, terminalDetails } = require('./diagnostics');

// Host routing uses a positive signed 32-bit instance id, not a numeric prefix.
function terminalId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 0x7fffffff ? id : null;
}

function cwdKey(value) {
  if (typeof value !== 'string' || !value) return '';
  let path = value.replace(/\\/g, '/');
  const windows = /^[a-z]:\//i.test(path) || path.startsWith('//');
  if (!windows && !path.startsWith('/')) return '';
  path = path.replace(/\/+$/, '') || '/';
  return windows ? path.toLowerCase() : path;
}

function createTerminalResolver({ log = () => {} } = {}) {
  const sessions = new Map();
  const sessionKey = (data, id) => typeof data.hook?.session_id === 'string' && data.hook.session_id
    ? JSON.stringify([id, data.hook.session_id]) : null;

  async function resolve(data, context = {}) {
    const sourceId = terminalId(data.terminal_id);
    const details = { ...hookDetails(data), ...context };
    if (!sourceId) {
      log('warn', 'terminal.invalid_id', details);
      return null; // An absent/malformed id must never select another terminal.
    }
    // Compatibility with hosts that predate terminal.list; no guessed remapping.
    if (typeof hecaton.terminal?.list !== 'function') {
      log('warn', 'terminal.unverified_id', { ...details, reason: 'terminal.list unavailable' });
      return { sourceId, terminalId: sourceId, via: 'hook' };
    }
    const fail = (code, extra = {}) => {
      log('error', 'terminal.' + code, { ...details, ...extra });
      return { sourceId, error: { key: 'terminal.error.' + code, args: { terminal: sourceId } } };
    };
    if (!await permissions.ensure('terminal_list')) return fail('access_denied', { api: 'terminal.list', reason: 'permission_denied_before_call' });
    let result;
    try { result = await hecaton.terminal.list(); }
    catch (e) { return fail(permissions.isDenied(e) ? 'access_denied' : 'unavailable', { api: 'terminal.list', error: errorDetails(e) }); }
    if (result?.ok === false) return fail(permissions.isDenied(result) ? 'access_denied' : 'unavailable', { api: 'terminal.list', error: errorDetails(result) });
    const entries = Array.isArray(result) ? result : result?.terminals;
    if (!Array.isArray(entries)) return fail('unavailable', { reason: 'terminal.list returned no terminals array' });
    const terminals = entries.filter(t => t && !t.plugin_only && terminalId(t.id) !== null);
    const key = sessionKey(data, sourceId);
    const binding = key && sessions.get(key);
    const bound = binding?.id;
    // A session previously repaired from a stale inherited id keeps its target
    // even if another shell opens in the same directory (or reuses the old id).
    let target = bound && terminals.find(t => terminalId(t.id) === bound);
    let via = 'session';
    let basis = binding?.basis;
    if (!target) {
      if (key) sessions.delete(key);
      target = terminals.find(t => terminalId(t.id) === sourceId);
      via = 'hook';
      basis = 'hook';
    }
    if (!target) {
      const cwd = cwdKey(data.hook?.cwd);
      const candidates = cwd ? terminals.filter(t => cwdKey(t.cwd) === cwd) : [];
      const evidence = { cwd_key: cwd, bound_id: bound || null, candidate_count: candidates.length,
        candidates: candidates.map(terminalDetails), open_count: entries.length,
        open_ids: entries.map(t => t?.id), terminals: entries.map(terminalDetails) };
      if (candidates.length !== 1) return fail(candidates.length ? 'ambiguous' : 'not_found', evidence);
      target = candidates[0];
      via = 'cwd';
      basis = 'cwd';
      log('warn', 'terminal.cwd_fallback', { ...details, ...evidence, reason: 'Working-directory match is not proof of hook origin' });
    }
    const id = terminalId(target.id);
    if (key) sessions.set(key, { id, basis });
    log('info', 'terminal.resolved', { ...details, terminal_id: id, via, basis, target: terminalDetails(target) });
    return { sourceId, terminalId: id, via };
  }

  function forget(data) { sessions.delete(sessionKey(data, terminalId(data.terminal_id))); }
  return { resolve, forget };
}

module.exports = { createTerminalResolver };
