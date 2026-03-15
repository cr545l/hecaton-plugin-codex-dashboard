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

module.exports = {
  joinPath,
  baseName,
  stripAnsi,
};
