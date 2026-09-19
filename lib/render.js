const { t } = require('./i18n');
const { stringWidth, padEnd, truncate } = require('./text');
const permissions = require('./permissions');

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
  return colorForPercent(clamped) + '█'.repeat(filled) + colors.dim + '░'.repeat(empty) + ansi.reset;
}

function formatPercent(pct) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  return colorForPercent(clamped) + clamped.toFixed(1) + '%' + ansi.reset;
}

function formatTokens(tokens) {
  if (tokens == null) return t('value.none');
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'K';
  return String(tokens);
}

// 한도 창 길이(분) -> 사람이 읽는 라벨. 5h / 7d 는 영어 축약이 아니라 번역 대상이다.
function formatWindowLabel(windowMinutes) {
  const minutes = windowMinutes || 0;
  if (minutes >= 1440) return t('time.days', { value: Math.round(minutes / 1440) });
  if (minutes >= 60) return t('time.hours', { value: Math.round(minutes / 60) });
  return t('time.minutes', { value: minutes });
}

function formatResetTime(epochSec) {
  if (!epochSec) return '';
  const remainMs = epochSec * 1000 - Date.now();
  if (remainMs <= 0) return t('time.now');
  const totalMin = Math.floor(remainMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  // 단위를 잇는 방식은 언어마다 다르다 — 영어는 "1h59m", 한국어는 "1시간 59분".
  const join = t('time.join');
  if (days > 0) return t('time.days', { value: days }) + (hours > 0 ? join + t('time.hours', { value: hours }) : '');
  if (hours > 0) return t('time.hours', { value: hours }) + (minutes > 0 ? join + t('time.minutes', { value: minutes }) : '');
  return t('time.minutes', { value: minutes });
}

// Exact local wall-clock time: 2026-07-26 14:30
function formatExactTime(epochSec) {
  if (!epochSec) return null;
  try {
    const d = new Date(epochSec * 1000);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return null;
  }
}

// Full remaining duration without truncation: 2d 3h 20m
function formatDurationLong(ms) {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(t('time.days', { value: days }));
  if (hours > 0) parts.push(t('time.hours', { value: hours }));
  parts.push(t('time.minutes', { value: minutes }));
  return parts.join(' ');
}

function buildResetTooltip(label, epochSec) {
  const exact = formatExactTime(epochSec);
  if (!exact) return null;
  const remainMs = epochSec * 1000 - Date.now();
  const remaining = remainMs > 0 ? formatDurationLong(remainMs) : t('time.now');
  return [
    label,
    t('tooltip.resets', { time: exact }),
    t('tooltip.remaining', { value: remaining }),
  ].join('\n');
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return t('time.secondsAgo', { value: diffSec });
    if (diffSec < 3600) return t('time.minutesAgo', { value: Math.floor(diffSec / 60) });
    if (diffSec < 86400) return t('time.hoursAgo', { value: Math.floor(diffSec / 3600) });
    return t('time.daysAgo', { value: Math.floor(diffSec / 86400) });
  } catch {
    return '';
  }
}

// 가운데 정렬도 폭 기준 — 번역문은 글자 수가 같아도 폭이 두 배가 될 수 있다.
function centerText(text, width) {
  const pad = Math.max(0, Math.floor((width - stringWidth(text)) / 2));
  return ' '.repeat(pad) + text;
}

function drawBox(lines, width) {
  const top = colors.border + '┌' + '─'.repeat(width - 2) + '┐' + ansi.reset;
  const bottom = colors.border + '└' + '─'.repeat(width - 2) + '┘' + ansi.reset;
  const result = [top];
  for (let i = 0; i < lines.length; i++) {
    // 번역문이 길어 박스를 넘기면 테두리가 어긋난다 — 내부 폭에 맞춰 잘라 넣는다.
    const line = truncate(lines[i], width - 3, '…');
    const pad = Math.max(0, width - 3 - stringWidth(line));
    result.push(colors.border + '│' + ansi.reset + ' ' + line + ' '.repeat(pad) + colors.border + '│' + ansi.reset);
  }
  result.push(bottom);
  return result;
}

function drawSeparator(width) {
  return colors.separator + '─'.repeat(width - 2) + ansi.reset;
}

// 상태·오류 문구는 {key, args} 로 들고 다닌다. 완성된 문자열을 state 에 넣어 두면
// 실행 중에 언어가 바뀌어도 그 줄만 이전 언어로 남는다.
function message(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return t(entry.key, entry.args);
}

// 라벨 칸 폭은 언어마다 다르다 — 같은 섹션의 라벨을 모아 가장 긴 것에 맞춘다.
function labelColumn(keys) {
  let width = 0;
  for (const key of keys) width = Math.max(width, stringWidth(t(key)));
  return (key) => colors.label + padEnd(t(key), width + 1) + ansi.reset;
}

function createRenderer({ pluginVersion, configFile, initialCols, initialRows }) {
  let termCols = initialCols;
  let termRows = initialRows;
  let clickableAreas = [];
  let hoveredAreaIndex = -1;
  let currentButtons = [];
  // Hover areas of the minimized bar: { colStart, colEnd, label, resetsAt } (1-based cols)
  let minimizedTooltipAreas = [];
  let lastTooltipText = null;

  function setTooltip(text) {
    if (text === lastTooltipText) return;
    lastTooltipText = text;
    try {
      hecaton.window.set_tooltip({ text }).catch(() => null);
    } catch {
      /* host without tooltip support */
    }
  }

  function clearTooltip() {
    setTooltip('');
  }

  // Mouse coords are 1-based; the minimized bar is drawn on row 1.
  function updateMinimizedTooltip(col, row) {
    let text = '';
    if (row === 1) {
      for (let i = 0; i < minimizedTooltipAreas.length; i++) {
        const area = minimizedTooltipAreas[i];
        if (col >= area.colStart && col <= area.colEnd) {
          // Built on hover so the remaining time never goes stale between renders
          text = buildResetTooltip(area.label, area.resetsAt) || '';
          break;
        }
      }
    }
    setTooltip(text);
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

  function renderMinimized(state) {
    const cols = termCols;
    const d = state.data;
    let line = '';

    // The minimized bar has no buttons; drop areas left over from the full view
    clickableAreas = [];
    minimizedTooltipAreas = [];

    const plainLength = () => stringWidth(line);
    const addTooltipArea = (startIdx, label, resetsAt) => {
      if (!resetsAt) return;
      const endIdx = plainLength();
      if (endIdx > startIdx) {
        minimizedTooltipAreas.push({ colStart: startIdx + 1, colEnd: endIdx, label, resetsAt });
      }
    };

    if (d) {
      if (d.primary) {
        const pct = d.primary.usedPercent ?? 0;
        const reset = formatResetTime(d.primary.resetsAt);
        const windowLabel = formatWindowLabel(d.primary.windowMinutes);
        const segStart = plainLength();
        line += colors.label + (reset || windowLabel) + ': ' + ansi.reset;
        line += formatPercent(pct) + ' ' + progressBar(pct, 10);
        addTooltipArea(segStart, t('tooltip.limit', { window: windowLabel }), d.primary.resetsAt);
      }
      if (d.secondary) {
        const pct = d.secondary.usedPercent ?? 0;
        const reset = formatResetTime(d.secondary.resetsAt);
        const windowLabel = formatWindowLabel(d.secondary.windowMinutes);
        line += colors.dim + ' | ' + ansi.reset;
        const segStart = plainLength();
        line += colors.label + (reset || windowLabel) + ': ' + ansi.reset;
        line += formatPercent(pct) + ' ' + progressBar(pct, 10);
        addTooltipArea(segStart, t('tooltip.limit', { window: windowLabel }), d.secondary.resetsAt);
      }
      if (d.timestamp) {
        line += colors.dim + ' | ' + ansi.reset + colors.dim +
          t('minimized.data', { time: formatTimestamp(d.timestamp) }) + ansi.reset;
      }
    }

    // 그릴 게 없으면 상태를 적는다. 빈 바는 "플러그인이 죽었나?"로 읽히고,
    // 세션 JSONL 스캔은 파일 수에 따라 수 초 이상 걸린다.
    // 주의: 조건이 `!d` 면 안 된다 — 스캔은 끝났는데 rate limit 항목이 하나도 없으면
    //      d 는 truthy 인데 줄은 그대로 비어 있다(실측). 판정 기준은 "줄이 비었는가"다.
    if (plainLength() === 0) {
      const denied = state.deniedPermissions || [];
      const errorText = message(state.error);
      if (errorText) {
        line += colors.red + errorText + ansi.reset;
      } else if (denied.length) {
        // 권한 거부는 "데이터 없음"과 다르다 — 최소화 상태에서도 구분해 보여 준다.
        line += colors.red + permissions.deniedSummary(denied) + ansi.reset;
      } else if (state.scanProgress) {
        const p = state.scanProgress;
        line += colors.dim + t('minimized.scanning', { current: p.current, total: p.total }) + ansi.reset;
      } else if (state.loading) {
        line += colors.dim + t('minimized.loading') + ansi.reset;
      } else {
        line += colors.dim + t('minimized.noData') + ansi.reset;
      }
    }

    // 주의: 자르기가 빠지면 안 된다 — 최소화 바는 호스트 버퍼가 1행이라, 폭을 한 칸이라도
    //      넘기면 오토랩이 스크롤을 일으켜 방금 그린 줄이 통째로 사라진다(= 라벨만 남고 빈 바).
    //      번역문은 같은 글자 수라도 폭이 두 배가 될 수 있어 여기가 더 쉽게 터진다.
    if (stringWidth(line) > cols) {
      line = truncate(line, cols);
    }
    const pad = Math.max(0, cols - stringWidth(line));
    process.stdout.write(ansi.clear + ansi.hideCursor);
    process.stdout.write(ansi.moveTo(1, 1) + line + ' '.repeat(pad) + ansi.reset);
  }

  function render(state) {
    const width = Math.min(termCols, 84);
    const lines = [];
    let buttonLineIdx = -1;
    currentButtons = [];
    const denied = state.deniedPermissions || [];
    const errorText = message(state.error);

    lines.push('');
    lines.push(centerText(colors.title + ansi.bold + ' ' + t('app.title') + ' ' + ansi.reset + colors.dim + 'v' + pluginVersion + ansi.reset, width));
    lines.push('');

    if (errorText) {
      lines.push(centerText(colors.red + errorText + ansi.reset, width));
      lines.push('');
    } else if (state.loading) {
      lines.push(centerText(colors.dim + t('state.scanning') + ansi.reset, width));
      if (state.scanProgress) {
        lines.push(centerText(colors.dim + t('state.scanProgress', {
          current: state.scanProgress.current, total: state.scanProgress.total,
        }) + ' ' + ansi.reset + colors.cyan + state.scanProgress.fileName + ansi.reset, width));
      }
      lines.push('');
    } else if (!state.data || (!state.data.primary && !state.data.secondary && !state.data.totalUsage && !state.data.lastUsage)) {
      // 권한이 막혀 비어 있는 것과 기록이 없어 비어 있는 것은 다른 사건이다.
      if (denied.length) {
        lines.push(centerText(colors.red + permissions.primaryDenial(denied) + ansi.reset, width));
        lines.push(centerText(colors.dim + permissions.deniedHint(denied) + ansi.reset, width));
      } else {
        lines.push(centerText(colors.yellow + t('state.noData') + ansi.reset, width));
        lines.push(centerText(colors.dim + t('state.noDataHint') + ansi.reset, width));
      }
      lines.push('');
    }

    if (state.data && (state.data.primary || state.data.secondary || state.data.totalUsage || state.data.lastUsage)) {
      const d = state.data;

      lines.push('  ' + colors.title + ansi.bold + t('section.rateLimits') + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));

      const windowCol = Math.max(
        d.primary ? stringWidth(formatWindowLabel(d.primary.windowMinutes)) : 0,
        d.secondary ? stringWidth(formatWindowLabel(d.secondary.windowMinutes)) : 0,
        4,
      ) + 1;

      for (const limit of [d.primary, d.secondary]) {
        if (!limit) continue;
        const pct = limit.usedPercent ?? 0;
        const reset = formatResetTime(limit.resetsAt);
        lines.push('  ' + colors.label + padEnd(formatWindowLabel(limit.windowMinutes), windowCol) + ansi.reset +
          progressBar(pct) + '  ' + formatPercent(pct) +
          (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : ''));
      }

      lines.push('');

      if (d.lastUsage || d.totalUsage) {
        lines.push('  ' + colors.title + ansi.bold + t('section.tokenUsage') + ansi.reset);
        lines.push('  ' + drawSeparator(width - 3));
        const label = labelColumn(['label.lastTurn', 'label.session', 'label.total', 'label.context']);

        const usageLine = (key, usage) => '  ' + label(key) +
          colors.value + formatTokens(usage.input_tokens) + ansi.reset + colors.dim + ' ' + t('value.in') + ansi.reset +
          (usage.cached_input_tokens
            ? colors.dim + ' (' + t('value.cached', { value: formatTokens(usage.cached_input_tokens) }) + ')' + ansi.reset
            : '') +
          colors.dim + ' / ' + ansi.reset +
          colors.cyan + formatTokens(usage.output_tokens) + ansi.reset + colors.dim + ' ' + t('value.out') + ansi.reset;

        if (d.lastUsage) lines.push(usageLine('label.lastTurn', d.lastUsage));

        if (d.totalUsage) {
          lines.push(usageLine('label.session', d.totalUsage));
          if (d.totalUsage.total_tokens) {
            lines.push('  ' + label('label.total') + colors.orange + ansi.bold + formatTokens(d.totalUsage.total_tokens) + ansi.reset +
              colors.dim + ' ' + t('value.tokens') + ansi.reset);
          }
        }

        if (d.contextWindow) {
          lines.push('  ' + label('label.context') + colors.value + formatTokens(d.contextWindow) + ansi.reset +
            colors.dim + ' ' + t('value.window') + ansi.reset);
        }

        lines.push('');
      }

      if (d.credits) {
        lines.push('  ' + colors.title + ansi.bold + t('section.account') + ansi.reset);
        lines.push('  ' + drawSeparator(width - 3));
        const creditInfo = d.credits.unlimited
          ? t('value.unlimited')
          : d.credits.has_credits
            ? t('value.balance', { value: d.credits.balance ?? t('value.unknown') })
            : t('value.noCredits');
        lines.push('  ' + colors.label + t('label.credits') + ' ' + ansi.reset + colors.value + creditInfo + ansi.reset +
          (d.planType ? colors.dim + '  |  ' + t('value.plan', { plan: d.planType }) + ansi.reset : ''));
        lines.push('');
      }
    }

    lines.push('  ' + colors.title + ansi.bold + t('section.sessionSource') + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    const sourceLabel = labelColumn([
      'label.mode', 'label.root', 'label.config', 'label.watcher', 'label.access', 'label.latest', 'label.scanned',
    ]);
    lines.push('  ' + sourceLabel('label.mode') + colors.value + (state.usingCustomRoot ? t('value.customFolder') : t('value.defaultFolder')) + ansi.reset);
    lines.push('  ' + sourceLabel('label.root') + colors.dim + state.sessionRoot + ansi.reset);
    lines.push('  ' + sourceLabel('label.config') + colors.dim + configFile + ansi.reset);
    lines.push('  ' + sourceLabel('label.watcher') + colors.value + t('value.watcherPoll') + ansi.reset + colors.dim + '  |  ' + t('value.renderTick') + ansi.reset);

    // 권한은 데이터가 없을 때만 궁금한 게 아니다 — 무엇이 열려 있는지 상시 보여 준다.
    const states = state.permissionStates || {};
    const accessParts = permissions.ALL.map((permission) => {
      const value = states[permission] || 'unknown';
      const color = value === 'granted' ? colors.green : value === 'denied' ? colors.red : colors.dim;
      return colors.dim + t('permission.name.' + permission) + ' ' + ansi.reset +
        color + t('permission.state.' + value) + ansi.reset;
    });
    // 거부 설명과 해결 방법은 위쪽 안내와 상태줄이 맡는다 — 여기서는 상태만 보여 준다.
    lines.push('  ' + sourceLabel('label.access') + accessParts.join(colors.dim + ' | ' + ansi.reset));

    if (state.data && state.data._debug) {
      lines.push('  ' + sourceLabel('label.latest') + colors.dim + (state.data._debug.sourceFile || t('value.none')) + ansi.reset);
      lines.push('  ' + sourceLabel('label.scanned') + colors.dim + (state.data._debug.folders || t('value.none')) + ansi.reset);
    }
    lines.push('');

    lines.push('  ' + colors.title + ansi.bold + t('section.overlay') + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    const elapsed = Date.now() - state.startTime;
    const upMin = Math.floor(elapsed / 60000);
    const uptime = upMin >= 60
      ? t('time.hours', { value: Math.floor(upMin / 60) }) + t('time.join') + t('time.minutes', { value: upMin % 60 })
      : t('time.minutes', { value: upMin });
    lines.push('  ' + colors.label + t('label.uptime') + ' ' + ansi.reset + colors.value + uptime + ansi.reset +
      colors.dim + '  |  ' + ansi.reset + colors.label + t('label.data') + ' ' + ansi.reset +
      colors.value + formatTimestamp(state.data ? state.data.timestamp : null) + ansi.reset);
    const statusText = message(state.status);
    if (statusText) {
      lines.push('  ' + colors.dim + statusText + ansi.reset);
    }

    lines.push('');
    lines.push('  ' + drawSeparator(width - 3));
    // 라벨은 그리는 자리에서 t() 로 만든다 — 모듈 상수로 굳히면 첫 언어에 고정된다.
    currentButtons = [
      { label: t('button.refresh'), action: 'refresh' },
      { label: t('button.pickFolder'), action: 'pick_folder' },
      { label: t('button.defaultRoot'), action: 'default_root' },
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
      // 클릭 영역도 폭 기준으로 누적한다 — 한글 라벨은 글자 수와 칸 수가 다르므로
      // indexOf 로 찾은 문자 위치를 열 번호로 쓸 수 없다.
      let cursor = startCol + 2;
      for (let i = 0; i < currentButtons.length; i++) {
        const btnWidth = stringWidth(currentButtons[i].label);
        clickableAreas.push({
          row: screenRow,
          colStart: cursor,
          colEnd: cursor + btnWidth - 1,
          action: currentButtons[i].action,
        });
        cursor += btnWidth + 2;
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
    updateMinimizedTooltip,
    clearTooltip,
  };
}

module.exports = {
  ansi,
  createRenderer,
};
