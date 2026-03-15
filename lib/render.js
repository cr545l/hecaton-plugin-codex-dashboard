const { stripAnsi } = require('./path');

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

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
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

function createRenderer({ pluginVersion, configFile, initialCols, initialRows }) {
  let termCols = initialCols;
  let termRows = initialRows;
  let clickableAreas = [];
  let hoveredAreaIndex = -1;
  let currentButtons = [];

  function buildHintText(buttons) {
    let result = '';
    for (let i = 0; i < buttons.length; i++) {
      if (i > 0) result += '  ';
      const color = i === hoveredAreaIndex ? colors.value + ansi.bold : colors.dim;
      result += color + buttons[i].label + ansi.reset;
    }
    return result;
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
    lines.push(centerText(colors.title + ansi.bold + ' Codex Dashboard ' + ansi.reset + colors.dim + 'v' + pluginVersion + ansi.reset, width));
    lines.push('');

    if (state.error) {
      lines.push(centerText(colors.red + state.error + ansi.reset, width));
      lines.push('');
    } else if (state.loading) {
      lines.push(centerText(colors.dim + 'Scanning sessions...' + ansi.reset, width));
      if (state.scanProgress) {
        lines.push(centerText(colors.dim + '[' + state.scanProgress.current + '/' + state.scanProgress.total + '] ' + ansi.reset + colors.cyan + state.scanProgress.fileName + ansi.reset, width));
      }
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
    lines.push('  ' + colors.label + 'Config: ' + ansi.reset + colors.dim + configFile + ansi.reset);
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

  function setTerminalSize(cols, rows) {
    termCols = cols || termCols;
    termRows = rows || termRows;
  }

  function setHoverFromMouse(col, row) {
    let newHover = -1;
    for (let i = 0; i < clickableAreas.length; i++) {
      const area = clickableAreas[i];
      if (row === area.row && col >= area.colStart && col <= area.colEnd) {
        newHover = i;
        break;
      }
    }
    const changed = newHover !== hoveredAreaIndex;
    hoveredAreaIndex = newHover;
    return changed;
  }

  function findActionAt(col, row) {
    for (let i = 0; i < clickableAreas.length; i++) {
      const area = clickableAreas[i];
      if (row === area.row && col >= area.colStart && col <= area.colEnd) {
        return area.action;
      }
    }
    return null;
  }

  return {
    ansi,
    render,
    renderMinimized,
    setTerminalSize,
    setHoverFromMouse,
    findActionAt,
  };
}

module.exports = {
  ansi,
  createRenderer,
};
