#!/usr/bin/env node

/**
 * Codex Dashboard - Hecaton Plugin
 *
 * Displays Codex CLI rate limits and token usage by parsing session JSONL logs.
 * Uses host file APIs for directory access and polling-based change detection.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   p / P   - Pick session folder
 *   d / D   - Reset to default session folder
 *   q / ESC - Close (handled by host)
 */

const PLUGIN_VERSION = (() => {
  try {
    const result = hecaton.fs_read_file({ path: __dirname + '/plugin.json' });
    return result.ok ? JSON.parse(result.text).version : '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

const colors = {
  bg: CSI + '49m',
  title: CSI + '35m',
  label: CSI + '39m',
  value: CSI + '39m',
  dim: CSI + '2m',
  green: CSI + '32m',
  yellow: CSI + '33m',
  red: CSI + '31m',
  cyan: CSI + '36m',
  orange: CSI + '33m',
  border: CSI + '2m',
  separator: CSI + '2m',
};

const PLUGIN_DIR_NAME = (() => {
  const parts = __dirname.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'hecaton-plugin-codex-dashboard';
})();
const CONFIG_DIR = joinPath(hecaton.get_home_dir().home, '.hecaton', 'data', PLUGIN_DIR_NAME);
const CONFIG_FILE = joinPath(CONFIG_DIR, 'config.json');

let termCols = parseInt((hecaton.get_env({ name: 'HECA_COLS' }) || {}).value || '80', 10);
let termRows = parseInt((hecaton.get_env({ name: 'HECA_ROWS' }) || {}).value || '24', 10);
let clickableAreas = [];
let hoveredAreaIndex = -1;
let currentButtons = [];
let rpcId = 1;
const pendingRpc = new Map();

function joinPath() {
  return Array.from(arguments).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function baseName(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

function loadConfig() {
  try {
    const result = hecaton.fs_read_file({ path: CONFIG_FILE });
    if (!result.ok) return {};
    return JSON.parse(result.text);
  } catch {
    return {};
  }
}

function saveConfig(data) {
  try {
    hecaton.fs_mkdir({ path: CONFIG_DIR, recursive: true });
    hecaton.fs_write_file({ path: CONFIG_FILE, text: JSON.stringify(data, null, 2) });
  } catch {
    /* ignore config write errors */
  }
}

function getDefaultSessionsRoot() {
  const envHome = (hecaton.get_env({ name: 'CODEX_HOME' }) || {}).value;
  const homeDir = hecaton.get_home_dir().home;
  if (envHome) return joinPath(envHome, 'sessions');
  return joinPath(homeDir, '.codex', 'sessions');
}

function getSessionsRoot(config) {
  if (config && config.sessionRoot) return config.sessionRoot;
  return getDefaultSessionsRoot();
}

function extractTimestampFromName(name) {
  const match = String(name || '').match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return 0;
  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`).getTime() || 0;
}

function listSubDirs(parentPath) {
  try {
    const result = hecaton.fs_read_dir({ path: parentPath });
    if (!result.ok) return [];
    return result.entries.filter((entry) => !entry.isFile).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function fileSortKey(entry, fallbackName) {
  return entry.mtimeMs || entry.modifiedTime || entry.lastWriteTime || extractTimestampFromName(fallbackName);
}

function findRecentJsonlFiles(root, daysBack, limit) {
  const files = [];
  const checkedFolders = [];
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (daysBack || 7));

  const years = listSubDirs(root);
  for (let yi = years.length - 1; yi >= 0; yi--) {
    const yPath = joinPath(root, years[yi]);
    const months = listSubDirs(yPath);
    for (let mi = months.length - 1; mi >= 0; mi--) {
      const mPath = joinPath(yPath, months[mi]);
      const days = listSubDirs(mPath);
      for (let di = days.length - 1; di >= 0; di--) {
        const folderDate = new Date(`${years[yi]}-${months[mi]}-${days[di]}T00:00:00`);
        if (folderDate < cutoff) continue;

        const dPath = joinPath(mPath, days[di]);
        try {
          const result = hecaton.fs_read_dir({ path: dPath });
          if (!result.ok) {
            checkedFolders.push(`${months[mi]}/${days[di]}:ERR`);
            continue;
          }
          const entries = result.entries
            .filter((entry) => entry.isFile && entry.name.endsWith('.jsonl'))
            .map((entry) => ({
              path: joinPath(dPath, entry.name),
              name: entry.name,
              sortKey: fileSortKey(entry, entry.name),
            }));
          checkedFolders.push(`${months[mi]}/${days[di]}:${entries.length}`);
          files.push.apply(files, entries);
        } catch {
          checkedFolders.push(`${months[mi]}/${days[di]}:CATCH`);
        }
        if (files.length >= limit) break;
      }
      if (files.length >= limit) break;
    }
    if (files.length >= limit) break;
  }

  files.sort((a, b) => b.sortKey - a.sortKey);
  const result = files.slice(0, limit || 20);
  result._checkedFolders = checkedFolders;
  result._root = root;
  result._now = now.toISOString();
  return result;
}

function tailRead(filePath, maxBytes) {
  try {
    const result = hecaton.fs_read_file({ path: filePath });
    if (!result.ok) return '';
    const text = result.text || '';
    const limit = maxBytes || 256 * 1024;
    return text.length > limit ? text.slice(text.length - limit) : text;
  } catch {
    return '';
  }
}

function parseLatestRateLimits(root) {
  const files = findRecentJsonlFiles(root, 7, 20);
  if (files.length === 0) {
    return {
      _debug: {
        root,
        now: files._now || new Date().toISOString(),
        folders: (files._checkedFolders || []).join(' '),
      },
    };
  }

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const content = tailRead(file.path);
    const lines = content.split('\n').filter((line) => line.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const payload = obj.payload || obj;
        const type = String(payload.type || '').toLowerCase();
        if (type !== 'token_count' || !payload.rate_limits) continue;

        const rl = payload.rate_limits;
        const info = payload.info || {};
        const result = {
          timestamp: obj.timestamp || null,
          sessionRoot: root,
          primary: null,
          secondary: null,
          credits: rl.credits || null,
          totalUsage: info.total_token_usage || null,
          lastUsage: info.last_token_usage || null,
          contextWindow: info.model_context_window || null,
          planType: rl.plan_type || null,
          _debug: {
            root: files._root || root,
            now: files._now || new Date().toISOString(),
            folders: (files._checkedFolders || []).join(' '),
            sourceFile: file.path,
            sourceName: baseName(file.path),
            sortKey: file.sortKey,
            fileCount: files.length,
          },
        };

        if (rl.primary) {
          result.primary = {
            usedPercent: rl.primary.used_percent ?? null,
            remainingPercent: rl.primary.remaining_percent ?? null,
            windowMinutes: rl.primary.window_minutes ?? 300,
            resetsAt: rl.primary.resets_at ?? null,
          };
          if (result.primary.usedPercent == null && result.primary.remainingPercent != null) {
            result.primary.usedPercent = 100 - result.primary.remainingPercent;
          }
        }

        if (rl.secondary) {
          result.secondary = {
            usedPercent: rl.secondary.used_percent ?? null,
            remainingPercent: rl.secondary.remaining_percent ?? null,
            windowMinutes: rl.secondary.window_minutes ?? 10080,
            resetsAt: rl.secondary.resets_at ?? null,
          };
          if (result.secondary.usedPercent == null && result.secondary.remainingPercent != null) {
            result.secondary.usedPercent = 100 - result.secondary.remainingPercent;
          }
        }

        return result;
      } catch {
        /* skip malformed line */
      }
    }
  }

  return {
    sessionRoot: root,
    _debug: {
      root: files._root || root,
      now: files._now || new Date().toISOString(),
      folders: (files._checkedFolders || []).join(' '),
      sourceFile: files[0] ? files[0].path : null,
      sourceName: files[0] ? baseName(files[0].path) : null,
      sortKey: files[0] ? files[0].sortKey : null,
      fileCount: files.length,
    },
  };
}

function createWatchSignature(root) {
  const files = findRecentJsonlFiles(root, 2, 6);
  if (!files.length) return `${root}|empty`;
  const signatures = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const stat = hecaton.fs_stat({ path: file.path });
      signatures.push([
        file.path,
        stat && stat.ok !== false && stat.exists ? (stat.mtimeMs || stat.modifiedTime || stat.lastWriteTime || 0) : 0,
        stat && stat.ok !== false && stat.exists ? (stat.size || 0) : 0,
      ].join(':'));
    } catch {
      signatures.push(`${file.path}:ERR`);
    }
  }
  return `${root}|${signatures.join('|')}`;
}

function progressBar(percent, width) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * (width || 25));
  const empty = (width || 25) - filled;
  return colorForPercent(clamped) + '\u2588'.repeat(filled) + colors.dim + '\u2591'.repeat(empty) + ansi.reset;
}

function formatPercent(pct) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  return colorForPercent(clamped) + clamped.toFixed(1) + '%' + ansi.reset;
}

function formatTokens(tokens) {
  if (tokens == null) return '-';
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'K';
  return String(tokens);
}

function formatResetTime(epochSec) {
  if (!epochSec) return '';
  const remainMs = epochSec * 1000 - Date.now();
  if (remainMs <= 0) return 'now';
  const totalMin = Math.floor(remainMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${minutes}m`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  } catch {
    return '';
  }
}

function buildHintText(buttons) {
  let result = '';
  for (let i = 0; i < buttons.length; i++) {
    if (i > 0) result += '  ';
    const color = i === hoveredAreaIndex ? colors.value + ansi.bold : colors.dim;
    result += color + buttons[i].label + ansi.reset;
  }
  return result;
}

function centerText(text, width) {
  const plain = stripAnsi(text);
  const pad = Math.max(0, Math.floor((width - plain.length) / 2));
  return ' '.repeat(pad) + text;
}

function drawBox(lines, width) {
  const top = colors.border + '\u250c' + '\u2500'.repeat(width - 2) + '\u2510' + ansi.reset;
  const bottom = colors.border + '\u2514' + '\u2500'.repeat(width - 2) + '\u2518' + ansi.reset;
  const result = [top];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const plain = stripAnsi(line);
    const pad = Math.max(0, width - 2 - plain.length);
    result.push(colors.border + '\u2502' + ansi.reset + ' ' + line + ' '.repeat(pad > 0 ? pad - 1 : 0) + colors.border + '\u2502' + ansi.reset);
  }
  result.push(bottom);
  return result;
}

function drawSeparator(width) {
  return colors.separator + '\u2500'.repeat(width - 2) + ansi.reset;
}

function renderMinimized(state) {
  const cols = termCols;
  const d = state.data;
  let line = '';

  if (d) {
    if (d.primary) {
      const pct = d.primary.usedPercent ?? 0;
      const reset = formatResetTime(d.primary.resetsAt);
      const windowLabel = d.primary.windowMinutes === 300 ? '5h' : `${Math.round(d.primary.windowMinutes / 60)}h`;
      line += colors.label + (reset || windowLabel) + ': ' + ansi.reset;
      line += formatPercent(pct) + ' ' + progressBar(pct, 10);
    }
    if (d.secondary) {
      const pct = d.secondary.usedPercent ?? 0;
      const reset = formatResetTime(d.secondary.resetsAt);
      const windowLabel = d.secondary.windowMinutes === 10080 ? '7d' : `${Math.round(d.secondary.windowMinutes / 1440)}d`;
      line += colors.dim + ' | ' + ansi.reset;
      line += colors.label + (reset || windowLabel) + ': ' + ansi.reset;
      line += formatPercent(pct) + ' ' + progressBar(pct, 10);
    }
    if (d.timestamp) {
      line += colors.dim + ' | ' + ansi.reset + colors.dim + 'Data: ' + formatTimestamp(d.timestamp) + ansi.reset;
    }
  }

  const plain = stripAnsi(line);
  const pad = Math.max(0, cols - plain.length);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  process.stdout.write(ansi.moveTo(1, 1) + line + ' '.repeat(pad) + ansi.reset);
}

function render(state) {
  const width = Math.min(termCols, 84);
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  lines.push('');
  lines.push(centerText(colors.title + ansi.bold + ' Codex Dashboard ' + ansi.reset + colors.dim + 'v' + PLUGIN_VERSION + ansi.reset, width));
  lines.push('');

  if (state.error) {
    lines.push(centerText(colors.red + state.error + ansi.reset, width));
    lines.push('');
  } else if (state.loading) {
    lines.push(centerText(colors.dim + 'Scanning sessions...' + ansi.reset, width));
    lines.push('');
  } else if (!state.data || (!state.data.primary && !state.data.secondary && !state.data.totalUsage && !state.data.lastUsage)) {
    lines.push(centerText(colors.yellow + 'No recent Codex rate limit data found' + ansi.reset, width));
    lines.push(centerText(colors.dim + 'Pick a session folder or check the default path.' + ansi.reset, width));
    lines.push('');
  }

  if (state.data && (state.data.primary || state.data.secondary || state.data.totalUsage || state.data.lastUsage)) {
    const d = state.data;

    lines.push('  ' + colors.title + ansi.bold + 'Rate Limits' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    if (d.primary) {
      const pct = d.primary.usedPercent ?? 0;
      const reset = formatResetTime(d.primary.resetsAt);
      const windowLabel = d.primary.windowMinutes === 300 ? '5h' : `${Math.round(d.primary.windowMinutes / 60)}h`;
      lines.push('  ' + colors.label + windowLabel.padEnd(5) + ansi.reset + progressBar(pct) + '  ' + formatPercent(pct) + (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : ''));
    }

    if (d.secondary) {
      const pct = d.secondary.usedPercent ?? 0;
      const reset = formatResetTime(d.secondary.resetsAt);
      const windowLabel = d.secondary.windowMinutes === 10080 ? '7d' : `${Math.round(d.secondary.windowMinutes / 1440)}d`;
      lines.push('  ' + colors.label + windowLabel.padEnd(5) + ansi.reset + progressBar(pct) + '  ' + formatPercent(pct) + (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : ''));
    }

    lines.push('');

    if (d.lastUsage || d.totalUsage) {
      lines.push('  ' + colors.title + ansi.bold + 'Token Usage' + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));

      if (d.lastUsage) {
        const lu = d.lastUsage;
        lines.push('  ' + colors.label + 'Last turn: ' + ansi.reset + colors.value + formatTokens(lu.input_tokens) + ansi.reset + colors.dim + ' in' + ansi.reset + (lu.cached_input_tokens ? colors.dim + ' (' + formatTokens(lu.cached_input_tokens) + ' cached)' + ansi.reset : '') + colors.dim + ' / ' + ansi.reset + colors.cyan + formatTokens(lu.output_tokens) + ansi.reset + colors.dim + ' out' + ansi.reset);
      }

      if (d.totalUsage) {
        const tu = d.totalUsage;
        lines.push('  ' + colors.label + 'Session:   ' + ansi.reset + colors.value + formatTokens(tu.input_tokens) + ansi.reset + colors.dim + ' in' + ansi.reset + (tu.cached_input_tokens ? colors.dim + ' (' + formatTokens(tu.cached_input_tokens) + ' cached)' + ansi.reset : '') + colors.dim + ' / ' + ansi.reset + colors.cyan + formatTokens(tu.output_tokens) + ansi.reset + colors.dim + ' out' + ansi.reset);
        if (tu.total_tokens) {
          lines.push('  ' + colors.label + 'Total:     ' + ansi.reset + colors.orange + ansi.bold + formatTokens(tu.total_tokens) + ansi.reset + colors.dim + ' tokens' + ansi.reset);
        }
      }

      if (d.contextWindow) {
        lines.push('  ' + colors.label + 'Context:   ' + ansi.reset + colors.value + formatTokens(d.contextWindow) + ansi.reset + colors.dim + ' window' + ansi.reset);
      }

      lines.push('');
    }

    if (d.credits) {
      lines.push('  ' + colors.title + ansi.bold + 'Account' + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));
      const creditInfo = d.credits.unlimited ? 'Unlimited' : d.credits.has_credits ? `Balance: ${d.credits.balance ?? 'N/A'}` : 'No credits';
      lines.push('  ' + colors.label + 'Credits: ' + ansi.reset + colors.value + creditInfo + ansi.reset + (d.planType ? colors.dim + '  |  plan: ' + d.planType + ansi.reset : ''));
      lines.push('');
    }
  }

  lines.push('  ' + colors.title + ansi.bold + 'Session Source' + ansi.reset);
  lines.push('  ' + drawSeparator(width - 3));
  lines.push('  ' + colors.label + 'Mode: ' + ansi.reset + colors.value + (state.usingCustomRoot ? 'Custom folder' : 'Default folder') + ansi.reset);
  lines.push('  ' + colors.label + 'Root: ' + ansi.reset + colors.dim + state.sessionRoot + ansi.reset);
  lines.push('  ' + colors.label + 'Config: ' + ansi.reset + colors.dim + CONFIG_FILE + ansi.reset);
  lines.push('  ' + colors.label + 'Watcher: ' + ansi.reset + colors.value + '3s poll' + ansi.reset + colors.dim + '  |  render tick 30s' + ansi.reset);
  if (state.data && state.data._debug) {
    lines.push('  ' + colors.label + 'Latest: ' + ansi.reset + colors.dim + (state.data._debug.sourceFile || '-') + ansi.reset);
    lines.push('  ' + colors.label + 'Scanned: ' + ansi.reset + colors.dim + (state.data._debug.folders || '-') + ansi.reset);
  }
  lines.push('');

  lines.push('  ' + colors.title + ansi.bold + 'Overlay' + ansi.reset);
  lines.push('  ' + drawSeparator(width - 3));
  const elapsed = Date.now() - state.startTime;
  const upMin = Math.floor(elapsed / 60000);
  const uptime = upMin >= 60 ? `${Math.floor(upMin / 60)}h${upMin % 60}m` : `${upMin}m`;
  lines.push('  ' + colors.label + 'Uptime: ' + ansi.reset + colors.value + uptime + ansi.reset + colors.dim + '  |  ' + ansi.reset + colors.label + 'Data: ' + ansi.reset + colors.value + formatTimestamp(state.data ? state.data.timestamp : null) + ansi.reset);
  if (state.statusLine) {
    lines.push('  ' + colors.dim + state.statusLine + ansi.reset);
  }

  lines.push('');
  lines.push('  ' + drawSeparator(width - 3));
  currentButtons = [
    { label: '[r] Refresh', action: 'refresh' },
    { label: '[p] Pick Folder', action: 'pick_folder' },
    { label: '[d] Default Root', action: 'default_root' },
  ];
  buttonLineIdx = lines.length;
  lines.push('  ' + buildHintText(currentButtons));

  const boxed = drawBox(lines, width);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  const startRow = Math.max(1, Math.floor((termRows - boxed.length) / 2));
  const startCol = Math.max(1, Math.floor((termCols - width) / 2));
  for (let i = 0; i < boxed.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + boxed[i] + ansi.reset);
  }

  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx + 1;
    const contentStart = startCol + 2;
    const plainLine = stripAnsi(lines[buttonLineIdx]);
    for (let i = 0; i < currentButtons.length; i++) {
      const btn = currentButtons[i];
      const idx = plainLine.indexOf(btn.label);
      if (idx >= 0) {
        clickableAreas.push({
          row: screenRow,
          colStart: contentStart + idx,
          colEnd: contentStart + idx + btn.label.length - 1,
          action: btn.action,
        });
      }
    }
  }
  if (hoveredAreaIndex >= clickableAreas.length) hoveredAreaIndex = -1;
}

function sendRpc(method, params) {
  const id = rpcId++;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
  return new Promise((resolve) => {
    pendingRpc.set(id, resolve);
    setTimeout(() => {
      if (pendingRpc.has(id)) {
        pendingRpc.delete(id);
        resolve(null);
      }
    }, 5000);
  });
}

function sendRpcNotify(method, params) {
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

function handleRpcResponse(json) {
  if (json.id != null && pendingRpc.has(json.id)) {
    const resolve = pendingRpc.get(json.id);
    pendingRpc.delete(json.id);
    resolve(json.result || null);
  }
}

async function main() {
  const config = loadConfig();
  const state = {
    loading: true,
    error: null,
    data: null,
    startTime: Date.now(),
    minimized: false,
    sessionRoot: getSessionsRoot(config),
    usingCustomRoot: !!config.sessionRoot,
    statusLine: '',
  };

  let lastWatchSignature = '';
  let watchInterval = null;
  let clockInterval = null;

  function rerender() {
    if (state.minimized) renderMinimized(state);
    else render(state);
  }

  function updateTitle() {
    sendRpcNotify('set_title', { title: 'Codex: ' + baseName(state.sessionRoot) });
  }

  function refresh() {
    state.loading = true;
    state.error = null;
    rerender();

    try {
      state.data = parseLatestRateLimits(state.sessionRoot);
      state.loading = false;
      state.statusLine = 'Watching latest session files under ' + state.sessionRoot;
      lastWatchSignature = createWatchSignature(state.sessionRoot);
      rerender();
    } catch (e) {
      state.loading = false;
      state.error = 'Session scan failed: ' + (e && e.message ? e.message : 'unknown');
      state.statusLine = 'Check folder access or pick a different sessions root.';
      rerender();
    }
  }

  function setRoot(nextRoot, customRoot) {
    state.sessionRoot = nextRoot;
    state.usingCustomRoot = !!customRoot;
    state.statusLine = customRoot ? 'Using custom session folder.' : 'Using default Codex session folder.';
    saveConfig({ sessionRoot: customRoot ? nextRoot : '' });
    lastWatchSignature = '';
    updateTitle();
    refresh();
  }

  async function pickSessionFolder() {
    state.statusLine = 'Waiting for folder picker...';
    rerender();
    const result = await sendRpc('pick_folder', {});
    if (result && result.path) {
      setRoot(result.path, true);
      return;
    }
    state.statusLine = 'Folder selection cancelled.';
    rerender();
  }

  function resetToDefaultRoot() {
    setRoot(getDefaultSessionsRoot(), false);
  }

  function setupWatcher() {
    function checkForChanges() {
      if (state.loading || state.minimized) return;
      try {
        const nextSignature = createWatchSignature(state.sessionRoot);
        if (!lastWatchSignature) {
          lastWatchSignature = nextSignature;
          return;
        }
        if (nextSignature !== lastWatchSignature) {
          lastWatchSignature = nextSignature;
          refresh();
        }
      } catch {
        /* ignore watcher errors */
      }
    }

    watchInterval = setInterval(checkForChanges, 3000);
    clockInterval = setInterval(() => {
      if (!state.minimized) rerender();
    }, 30000);
  }

  function cleanup() {
    if (watchInterval) clearInterval(watchInterval);
    if (clockInterval) clearInterval(clockInterval);
    process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
  }

  render(state);
  updateTitle();
  refresh();
  setupWatcher();

  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {
    /* ignore */
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (key) => {
    if (key.indexOf('__HECA_RPC__') !== -1) {
      const segments = key.split('__HECA_RPC__');
      for (let i = 0; i < segments.length; i++) {
        const trimmed = segments[i].trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          if (json.id != null && (json.result || json.error)) {
            handleRpcResponse(json);
            continue;
          }
          if (json.method === 'resize' && json.params) {
            termCols = json.params.cols || termCols;
            termRows = json.params.rows || termRows;
            rerender();
          } else if (json.method === 'minimize') {
            state.minimized = true;
            renderMinimized(state);
          } else if (json.method === 'restore') {
            state.minimized = false;
            rerender();
            refresh();
          }
        } catch {
          /* ignore malformed segment */
        }
      }
      return;
    }

    const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let match;
    let hadMouse = false;
    while ((match = mouseRegex.exec(key)) !== null) {
      hadMouse = true;
      const cb = parseInt(match[1], 10);
      const cx = parseInt(match[2], 10);
      const cy = parseInt(match[3], 10);
      const isRelease = match[4] === 'm';

      if ((cb & 32) !== 0) {
        let newHover = -1;
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            newHover = i;
            break;
          }
        }
        if (newHover !== hoveredAreaIndex) {
          hoveredAreaIndex = newHover;
          rerender();
        }
        continue;
      }

      if (isRelease) continue;
      if (cb === 64) {
        refresh();
        continue;
      }
      if (cb === 65) continue;

      if (cb === 0) {
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            if (area.action === 'refresh') refresh();
            if (area.action === 'pick_folder') pickSessionFolder();
            if (area.action === 'default_root') resetToDefaultRoot();
            break;
          }
        }
      }
    }
    if (hadMouse) return;

    switch (key) {
      case 'r':
      case 'R':
        refresh();
        break;
      case 'p':
      case 'P':
        pickSessionFolder();
        break;
      case 'd':
      case 'D':
        resetToDefaultRoot();
        break;
      case 'q':
      case 'Q':
        cleanup();
        sendRpcNotify('close');
        break;
    }
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.stdin.on('end', () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write('Error: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
