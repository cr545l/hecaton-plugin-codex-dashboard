const { baseName, joinPath } = require('./path');

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function extractTimestampFromName(name) {
  const match = String(name || '').match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return 0;
  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`).getTime() || 0;
}

async function listSubDirs(parentPath) {
  try {
    const result = await withTimeout(hecaton.fs_read_dir({ path: parentPath }), 5000);
    if (!result.ok) return [];
    return result.entries.filter((entry) => !entry.isFile).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function fileSortKey(entry, fallbackName) {
  return entry.mtimeMs || entry.modifiedTime || entry.lastWriteTime || extractTimestampFromName(fallbackName);
}

async function findRecentJsonlFiles(root, daysBack, limit) {
  const files = [];
  const checkedFolders = [];
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (daysBack || 7));

  const years = await listSubDirs(root);
  for (let yi = years.length - 1; yi >= 0; yi--) {
    const yPath = joinPath(root, years[yi]);
    const months = await listSubDirs(yPath);
    for (let mi = months.length - 1; mi >= 0; mi--) {
      const mPath = joinPath(yPath, months[mi]);
      const days = await listSubDirs(mPath);
      for (let di = days.length - 1; di >= 0; di--) {
        const folderDate = new Date(`${years[yi]}-${months[mi]}-${days[di]}T00:00:00`);
        if (folderDate < cutoff) continue;

        const dPath = joinPath(mPath, days[di]);
        try {
          const result = await withTimeout(hecaton.fs_read_dir({ path: dPath }), 5000);
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

async function tailRead(filePath) {
  try {
    const tailLines = 200;
    const normalized = filePath.replace(/\//g, '\\');
    const result = await withTimeout(hecaton.exec_process({
      program: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Content -Path \'' + normalized + '\' -Tail ' + tailLines + ' -Encoding UTF8'],
      timeout: 10000,
    }), 12000);
    if (!result || !result.ok) return '';
    return result.stdout || '';
  } catch {
    return '';
  }
}

async function parseLatestRateLimits(root, onProgress) {
  const files = await findRecentJsonlFiles(root, 7, 20);
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
    if (onProgress) onProgress(fi + 1, files.length, baseName(file.path));
    const content = await tailRead(file.path);
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

async function createWatchSignature(root) {
  const files = await findRecentJsonlFiles(root, 2, 6);
  if (!files.length) return `${root}|empty`;
  const signatures = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const stat = await withTimeout(hecaton.fs_stat({ path: file.path }), 3000);
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

module.exports = {
  parseLatestRateLimits,
  createWatchSignature,
};
