#!/usr/bin/env node

/**
 * Codex Dashboard - Hecaton Plugin
 *
 * Displays Codex CLI rate limits and token usage by parsing
 * ~/.codex/sessions/ JSONL logs. No API calls needed.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   q / ESC - Close (handled by host)
 */

const PLUGIN_VERSION = (() => { try { const r = hecaton.fs_read_file({ path: __dirname + '/plugin.json' }); return r.ok ? JSON.parse(r.text).version : '1.0.0'; } catch { return '1.0.0'; } })();

// ============================================================
// Path utility (replaces require('path'))
// ============================================================
function joinPath(...parts) {
  return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// ============================================================
// ANSI Helpers
// ============================================================
const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  fg: (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

const colors = {
  bg: CSI + '49m',            // default background
  title: CSI + '35m',         // magenta
  label: CSI + '39m',         // default foreground
  value: CSI + '39m',         // default foreground
  dim: CSI + '2m',            // SGR dim
  green: CSI + '32m',         // green
  yellow: CSI + '33m',        // yellow
  red: CSI + '31m',           // red
  cyan: CSI + '36m',          // cyan
  orange: CSI + '33m',        // yellow
  border: CSI + '2m',         // SGR dim
  separator: CSI + '2m',      // SGR dim
};

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

// ============================================================
// JSONL Session Scanner
// ============================================================

function getSessionsRoot() {
  const envHome = (hecaton.get_env({ name: 'CODEX_HOME' }) || {}).value;
  const homeDir = hecaton.get_home_dir().home;
  if (envHome) return joinPath(envHome, 'sessions');
  return joinPath(homeDir, '.codex', 'sessions');
}

function findRecentJsonlFiles(root, daysBack = 7, limit = 20) {
  const files = [];
  const now = new Date();

  for (let offset = 0; offset <= daysBack; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() - offset);

    const y = day.getFullYear().toString();
    const m = String(day.getMonth() + 1).padStart(2, '0');
    const d = String(day.getDate()).padStart(2, '0');
    const folder = joinPath(root, y, m, d);

    try {
      const result = hecaton.fs_read_dir({ path: folder });
      if (!result.ok) continue;
      const entries = result.entries
        .filter(e => e.isFile && e.name.endsWith('.jsonl'))
        .map(e => ({
          path: joinPath(folder, e.name),
          mtime: e.mtimeMs || 0,
        }));
      files.push(...entries);
    } catch { /* folder doesn't exist */ }

    if (files.length >= limit) break;
  }

  // Sort by mtime descending (newest first)
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

function tailRead(filePath, maxBytes = 256 * 1024) {
  try {
    const result = hecaton.fs_read_file({ path: filePath });
    if (!result.ok) return '';
    const text = result.text;
    // If the file is larger than maxBytes, take only the tail portion
    if (text.length > maxBytes) {
      return text.slice(text.length - maxBytes);
    }
    return text;
  } catch {
    return '';
  }
}

function parseLatestRateLimits(root) {
  const files = findRecentJsonlFiles(root);
  if (files.length === 0) return null;

  for (const file of files) {
    const content = tailRead(file.path);
    const lines = content.split('\n').filter(l => l.trim());

    // Walk backwards to find the most recent token_count event
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const payload = obj.payload || obj;
        const type = (payload.type || '').toLowerCase();

        if (type === 'token_count' && payload.rate_limits) {
          const rl = payload.rate_limits;
          const info = payload.info || {};

          const result = {
            timestamp: obj.timestamp || null,
            primary: null,
            secondary: null,
            credits: rl.credits || null,
            totalUsage: info.total_token_usage || null,
            lastUsage: info.last_token_usage || null,
            contextWindow: info.model_context_window || null,
          };

          if (rl.primary) {
            result.primary = {
              usedPercent: rl.primary.used_percent ?? null,
              remainingPercent: rl.primary.remaining_percent ?? null,
              windowMinutes: rl.primary.window_minutes ?? 300,
              resetsAt: rl.primary.resets_at ?? null,
            };
            // Normalize to usedPercent
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
        }
      } catch { /* skip bad lines */ }
    }
  }
  return null;
}

// ============================================================
// Formatting
// ============================================================

function progressBar(percent, width = 25) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = colorForPercent(clamped);
  return color + '\u2588'.repeat(filled) + colors.dim + '\u2591'.repeat(empty) + ansi.reset;
}

function formatPercent(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  return colorForPercent(clamped) + clamped.toFixed(1) + '%' + ansi.reset;
}

function formatTokens(tokens) {
  if (tokens == null) return '-';
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'K';
  return tokens.toString();
}

function formatResetTime(epochSec) {
  if (!epochSec) return '';
  const resetMs = epochSec * 1000;
  const remainMs = resetMs - Date.now();
  if (remainMs <= 0) return 'now';
  const totalMin = Math.floor(remainMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `${days}d${hours > 0 ? hours + 'h' : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? minutes + 'm' : ''}`;
  return `${minutes}m`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return `${Math.floor(diffSec / 3600)}h ago`;
  } catch {
    return '';
  }
}

// ============================================================
// Rendering
// ============================================================

let termCols = parseInt((hecaton.get_env({ name: 'HECA_COLS' }) || {}).value || '80', 10);
let termRows = parseInt((hecaton.get_env({ name: 'HECA_ROWS' }) || {}).value || '24', 10);
let clickableAreas = [];
let hoveredAreaIndex = -1;
let currentButtons = [];

function buildHintText(buttons) {
  let result = '';
  for (let i = 0; i < buttons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + buttons[i].label + ansi.reset;
  }
  return result;
}

function centerText(text, width) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - plain.length) / 2));
  return ' '.repeat(pad) + text;
}

function drawBox(lines, width) {
  const top = colors.border + '\u250c' + '\u2500'.repeat(width - 2) + '\u2510' + ansi.reset;
  const bot = colors.border + '\u2514' + '\u2500'.repeat(width - 2) + '\u2518' + ansi.reset;
  const result = [top];
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - 2 - plain.length);
    result.push(
      colors.border + '\u2502' + ansi.reset + ' ' + line +
      ' '.repeat(pad > 0 ? pad - 1 : 0) +
      colors.border + '\u2502' + ansi.reset
    );
  }
  result.push(bot);
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
      line += colors.dim + ' | ' + ansi.reset;
      line += colors.dim + 'Data: ' + formatTimestamp(d.timestamp) + ansi.reset;
    }
  }

  // Pad to terminal width
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, cols - plain.length);
  line += ' '.repeat(pad);

  process.stdout.write(ansi.clear + ansi.hideCursor);
  process.stdout.write(ansi.moveTo(1, 1) + line + ansi.reset);
}

function render(state) {
  const width = Math.min(termCols, 72);
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  // Title
  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' Codex Dashboard ' + ansi.reset +
    colors.dim + 'v' + PLUGIN_VERSION + ansi.reset,
    width
  ));
  lines.push('');

  if (state.error) {
    lines.push(centerText(colors.red + state.error + ansi.reset, width));
    lines.push('');
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }];
    buttonLineIdx = lines.length;
    lines.push(centerText(buildHintText(currentButtons), width));
  } else if (state.loading) {
    lines.push(centerText(colors.dim + 'Scanning sessions...' + ansi.reset, width));
  } else if (!state.data) {
    lines.push(centerText(colors.yellow + 'No Codex session data found' + ansi.reset, width));
    lines.push(centerText(colors.dim + 'Check ~/.codex/sessions/' + ansi.reset, width));
    lines.push('');
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }];
    buttonLineIdx = lines.length;
    lines.push(centerText(buildHintText(currentButtons), width));
  } else {
    const d = state.data;

    // Rate Limits
    lines.push('  ' + colors.title + ansi.bold + 'Rate Limits' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    if (d.primary) {
      const pct = d.primary.usedPercent ?? 0;
      const reset = formatResetTime(d.primary.resetsAt);
      const windowLabel = d.primary.windowMinutes === 300 ? '5h' : `${Math.round(d.primary.windowMinutes / 60)}h`;
      lines.push(
        '  ' + colors.label + windowLabel.padEnd(5) + ansi.reset +
        progressBar(pct) + '  ' + formatPercent(pct) +
        (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : '')
      );
    }

    if (d.secondary) {
      const pct = d.secondary.usedPercent ?? 0;
      const reset = formatResetTime(d.secondary.resetsAt);
      const windowLabel = d.secondary.windowMinutes === 10080 ? '7d' : `${Math.round(d.secondary.windowMinutes / 1440)}d`;
      lines.push(
        '  ' + colors.label + windowLabel.padEnd(5) + ansi.reset +
        progressBar(pct) + '  ' + formatPercent(pct) +
        (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : '')
      );
    }

    if (!d.primary && !d.secondary) {
      lines.push('  ' + colors.dim + 'No rate limit data' + ansi.reset);
    }

    lines.push('');

    // Token Usage
    if (d.lastUsage || d.totalUsage) {
      lines.push('  ' + colors.title + ansi.bold + 'Token Usage' + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));

      if (d.lastUsage) {
        const lu = d.lastUsage;
        lines.push(
          '  ' + colors.label + 'Last turn: ' + ansi.reset +
          colors.value + formatTokens(lu.input_tokens) + ansi.reset +
          colors.dim + ' in' + ansi.reset +
          (lu.cached_input_tokens ? colors.dim + ' (' + formatTokens(lu.cached_input_tokens) + ' cached)' + ansi.reset : '') +
          colors.dim + ' / ' + ansi.reset +
          colors.cyan + formatTokens(lu.output_tokens) + ansi.reset +
          colors.dim + ' out' + ansi.reset
        );
      }

      if (d.totalUsage) {
        const tu = d.totalUsage;
        lines.push(
          '  ' + colors.label + 'Session:   ' + ansi.reset +
          colors.value + formatTokens(tu.input_tokens) + ansi.reset +
          colors.dim + ' in' + ansi.reset +
          (tu.cached_input_tokens ? colors.dim + ' (' + formatTokens(tu.cached_input_tokens) + ' cached)' + ansi.reset : '') +
          colors.dim + ' / ' + ansi.reset +
          colors.cyan + formatTokens(tu.output_tokens) + ansi.reset +
          colors.dim + ' out' + ansi.reset
        );
        if (tu.total_tokens) {
          lines.push(
            '  ' + colors.label + 'Total:     ' + ansi.reset +
            colors.orange + ansi.bold + formatTokens(tu.total_tokens) + ansi.reset +
            colors.dim + ' tokens' + ansi.reset
          );
        }
      }

      if (d.contextWindow) {
        lines.push(
          '  ' + colors.label + 'Context:   ' + ansi.reset +
          colors.value + formatTokens(d.contextWindow) + ansi.reset +
          colors.dim + ' window' + ansi.reset
        );
      }

      lines.push('');
    }

    // Credits
    if (d.credits) {
      lines.push('  ' + colors.title + ansi.bold + 'Account' + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));
      const creditInfo = d.credits.unlimited ? 'Unlimited' :
        d.credits.has_credits ? `Balance: ${d.credits.balance ?? 'N/A'}` : 'No credits';
      lines.push('  ' + colors.label + 'Credits: ' + ansi.reset + colors.value + creditInfo + ansi.reset);
      lines.push('');
    }

    // Session info
    lines.push('  ' + colors.title + ansi.bold + 'Session' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    const elapsed = Date.now() - state.startTime;
    const upMin = Math.floor(elapsed / 60000);
    const uptime = upMin >= 60 ? `${Math.floor(upMin / 60)}h${upMin % 60}m` : `${upMin}m`;
    lines.push(
      '  ' + colors.label + 'Uptime: ' + ansi.reset +
      colors.value + uptime + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Data: ' + ansi.reset +
      colors.value + formatTimestamp(d.timestamp) + ansi.reset
    );
    lines.push('');

    // Keyboard
    lines.push('  ' + drawSeparator(width - 3));
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }];
    buttonLineIdx = lines.length;
    lines.push('  ' + buildHintText(currentButtons));
  }

  lines.push('');

  const boxed = drawBox(lines, width);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  const startRow = Math.max(1, Math.floor((termRows - boxed.length) / 2));
  const startCol = Math.max(1, Math.floor((termCols - width) / 2));
  for (let i = 0; i < boxed.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + boxed[i] + ansi.reset);
  }

  // Record clickable areas for mouse support
  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx + 1; // +1 for box top border
    const contentStart = startCol + 2; // after | and space in box
    const plainLine = lines[buttonLineIdx].replace(/\x1b\[[0-9;]*m/g, '');
    for (const btn of currentButtons) {
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

// ============================================================
// JSON-RPC via stderr
// ============================================================

function sendRpc(method, params = {}, id = 1) {
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const state = {
    loading: true,
    error: null,
    data: null,
    startTime: Date.now(),
    minimized: false,
  };

  render(state);

  const root = getSessionsRoot();

  function rerender() {
    if (state.minimized) renderMinimized(state);
    else render(state);
  }

  function refresh() {
    state.loading = true;
    state.error = null;
    rerender();

    try {
      state.data = parseLatestRateLimits(root);
      state.loading = false;
      rerender();
    } catch (e) {
      state.error = 'Parse error: ' + (e.message || 'unknown');
      state.loading = false;
      rerender();
    }
  }

  refresh();

  // Auto-refresh every 60 seconds
  const autoRefresh = setInterval(refresh, 60000);

  // Keyboard input
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch { /* not a TTY */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (key) => {
    // Host RPC – multiple RPCs can arrive in a single pipe read, so split
    // and process each one separately.
    if (key.indexOf('__HECA_RPC__') !== -1) {
      const segments = key.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          if (json.method === 'resize' && json.params) {
            termCols = json.params.cols || termCols;
            termRows = json.params.rows || termRows;
            if (state.minimized) renderMinimized(state);
            else render(state);
          }
          if (json.method === 'minimize') {
            state.minimized = true;
            renderMinimized(state);
          }
          if (json.method === 'restore') {
            state.minimized = false;
            render(state);
          }
        } catch { /* ignore malformed segment */ }
      }
      return;
    }

    // Handle SGR mouse sequences: ESC [ < Cb ; Cx ; Cy M/m
    const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mouseMatch;
    let hadMouse = false;
    while ((mouseMatch = mouseRegex.exec(key)) !== null) {
      hadMouse = true;
      const cb = parseInt(mouseMatch[1], 10);
      const cx = parseInt(mouseMatch[2], 10);
      const cy = parseInt(mouseMatch[3], 10);
      const isRelease = mouseMatch[4] === 'm';

      // Motion events (cb bit 5 set)
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
          render(state);
        }
        continue;
      }

      if (isRelease) continue;

      // Scroll wheel up -> refresh
      if (cb === 64) { refresh(); continue; }
      if (cb === 65) continue; // scroll down -> ignore

      // Left click -> check clickable areas
      if (cb === 0) {
        for (const area of clickableAreas) {
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            switch (area.action) {
              case 'refresh': refresh(); break;
            }
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
      case 'q':
      case 'Q':
        cleanup();
        sendRpc('close');
        break;
    }
  });

  function cleanup() {
    clearInterval(autoRefresh);
    process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
