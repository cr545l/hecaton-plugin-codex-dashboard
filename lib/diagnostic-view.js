'use strict';

const { stringWidth, stripAnsi } = require('./text');

function wrap(text, width) {
  const result = [];
  for (const source of String(text).split('\n')) {
    const safe = stripAnsi(source).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    let line = '', used = 0;
    for (const ch of safe) {
      const size = stringWidth(ch);
      if (line && used + size > width) { result.push(line); line = ''; used = 0; }
      line += ch;
      used += size;
    }
    result.push(line);
  }
  return result;
}

function diagnosticLines(entries, width, errorsOnly = false) {
  const lines = [];
  for (const entry of (entries || []).slice().reverse()) {
    if (errorsOnly && entry.level === 'info') continue;
    lines.push(...wrap(`${entry.at} [${entry.level.toUpperCase()}] ${entry.stage} #${entry.id}`, width));
    lines.push(...wrap(JSON.stringify(entry.details, null, 2), width), '');
  }
  return lines;
}

module.exports = { diagnosticLines, wrap };
