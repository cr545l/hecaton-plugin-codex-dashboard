'use strict';

const { stripAnsi } = require('./text');

const MAX_ENTRIES = 200;
const MAX_CHARS = 128 * 1024;

// Bound persisted data and keep terminal escape sequences out of the log viewer.
function clean(value, depth = 0) {
  if (typeof value === 'string') return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1024);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (!value || typeof value !== 'object' || depth > 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 64).map(v => clean(v, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    const safe = clean(item, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function errorDetails(value) {
  return clean({ code: value?.error_code || value?.code || 'unknown',
    message: value?.error || value?.message || (typeof value === 'string' ? value : undefined) });
}

function hookDetails(data) {
  return clean({ event: data?.event, source_id: data?.terminal_id,
    session_id: data?.hook?.session_id, turn_id: data?.hook?.turn_id, cwd: data?.hook?.cwd,
    relay_pid: data?.relay?.pid, relay_parent_pid: data?.relay?.parent_pid });
}

function terminalDetails(terminal) {
  return clean({ id: terminal?.id, title: terminal?.title, alias: terminal?.alias, cwd: terminal?.cwd,
    shell: terminal?.shell, is_self: terminal?.is_self, plugin_only: terminal?.plugin_only,
    focused: terminal?.focused, hidden: terminal?.hidden });
}

function createDiagnosticLog({ path = '', onChange, limit = MAX_ENTRIES, maxChars = MAX_CHARS } = {}) {
  let entries = [];
  let chars = 0;
  let counter = 0;
  let revision = 0;
  let dirty = false;
  let timer = null;
  let closed = false;
  let loadPromise;
  let queue = Promise.resolve();
  let persistenceError = null;
  let readFailed = false;
  const run = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const changed = () => { try { onChange?.(); } catch { /* diagnostics must not break hooks */ } };
  const size = entry => JSON.stringify(entry).length;
  function trim() {
    while (entries.length > limit || chars > maxChars) chars -= size(entries.shift());
  }
  function setError(error) {
    if (JSON.stringify(persistenceError) === JSON.stringify(error)) return;
    persistenceError = error;
    changed();
  }

  function record(level, stage, details = {}) {
    if (closed) return null;
    const entry = { id: `${run}-${++counter}`, at: new Date().toISOString(), level,
      stage: clean(stage), details: clean(details) || {} };
    entries.push(entry);
    chars += size(entry);
    trim();
    revision++;
    dirty = true;
    changed();
    if (path && !timer && !readFailed && persistenceError?.code !== 'access_denied') {
      timer = setTimeout(() => { timer = null; flush(); }, 500);
      timer.unref?.();
    }
    return entry.id;
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!path) return;
      try {
        const result = await hecaton.fs.read_file({ path });
        if (result?.ok === false) {
          if (result.error_code === 'not_found') return;
          throw result;
        }
        if (!result?.content) return;
        const saved = JSON.parse(result.content);
        if (saved.version !== 1 || !Array.isArray(saved.entries)) throw { code: 'invalid_log', message: 'Invalid diagnostic log format' };
        const old = saved.entries.filter(e => e && typeof e.id === 'string' && typeof e.at === 'string' &&
          ['info', 'warn', 'error'].includes(e.level) && typeof e.stage === 'string').map(e => clean(e));
        entries = old.concat(entries);
        chars = entries.reduce((sum, entry) => sum + size(entry), 0);
        trim();
        changed();
      } catch (e) {
        readFailed = true; // Preserve an unreadable/corrupt existing file.
        setError(errorDetails(e));
      }
    })();
    return loadPromise;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    queue = queue.then(async () => {
      await load();
      if (!path || !dirty || readFailed) return;
      const writing = revision;
      try {
        const dir = path.replace(/[\\/][^\\/]+$/, '');
        const made = await hecaton.fs.mkdir({ path: dir, recursive: true });
        if (made?.ok === false) throw made;
        const result = await hecaton.fs.write_file({ path,
          content: JSON.stringify({ version: 1, entries }, null, 2) + '\n' });
        if (!result || result.ok === false) throw result || { code: 'write_failed' };
        if (revision === writing) dirty = false;
        setError(null);
      } catch (e) { setError(errorDetails(e)); }
    });
    return queue;
  }

  function snapshot() { return { path, persistenceError, limit, entries: entries.slice() }; }
  async function close() { closed = true; await flush(); }
  return { record, load, flush, close, snapshot };
}

module.exports = { createDiagnosticLog, errorDetails, hookDetails, terminalDetails };
