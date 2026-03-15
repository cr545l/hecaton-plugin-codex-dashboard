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

const { createConfigStore, loadPluginVersion } = require('./lib/config');
const { baseName } = require('./lib/path');
const { createRenderer } = require('./lib/render');
const { createRpcClient } = require('./lib/rpc');
const { createWatchSignature, parseLatestRateLimits } = require('./lib/session-data');

const pluginVersion = await loadPluginVersion(__dirname);
const pluginDirName = (() => {
  const parts = __dirname.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'hecaton-plugin-codex-dashboard';
})();

const configStore = await createConfigStore(pluginDirName);
const initialCols = parseInt((await hecaton.get_env({ name: 'HECA_COLS' })).value || '80', 10);
const initialRows = parseInt((await hecaton.get_env({ name: 'HECA_ROWS' })).value || '24', 10);
const renderer = createRenderer({
  pluginVersion,
  configFile: configStore.configFile,
  initialCols,
  initialRows,
});
const rpc = createRpcClient();

async function main() {
  const config = await configStore.loadConfig();
  const state = {
    loading: true,
    error: null,
    data: null,
    startTime: Date.now(),
    minimized: hecaton.initialState?.minimized ?? false,
    sessionRoot: await configStore.getSessionsRoot(config),
    usingCustomRoot: !!config.sessionRoot,
    statusLine: '',
  };

  let lastWatchSignature = '';
  let watchInterval = null;
  let clockInterval = null;

  function rerender() {
    if (state.minimized) renderer.renderMinimized(state);
    else renderer.render(state);
  }

  function updateTitle() {
    rpc.sendRpcNotify('set_title', { title: 'Codex: ' + baseName(state.sessionRoot) });
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    state.scanProgress = null;
    rerender();

    try {
      state.data = await parseLatestRateLimits(state.sessionRoot, (current, total, fileName) => {
        state.scanProgress = { current, total, fileName };
        rerender();
      });
      state.loading = false;
      state.scanProgress = null;
      state.statusLine = 'Watching latest session files under ' + state.sessionRoot;
      rerender();
      lastWatchSignature = await createWatchSignature(state.sessionRoot);
    } catch (e) {
      state.loading = false;
      state.error = 'Session scan failed: ' + (e && e.message ? e.message : 'unknown');
      state.statusLine = 'Check folder access or pick a different sessions root.';
      rerender();
    }
  }

  async function setRoot(nextRoot, customRoot) {
    state.sessionRoot = nextRoot;
    state.usingCustomRoot = !!customRoot;
    state.statusLine = customRoot ? 'Using custom session folder.' : 'Using default Codex session folder.';
    await configStore.saveConfig({ sessionRoot: customRoot ? nextRoot : '' });
    lastWatchSignature = '';
    updateTitle();
    await refresh();
  }

  async function pickSessionFolder() {
    state.statusLine = 'Waiting for folder picker...';
    rerender();
    const result = await rpc.sendRpc('pick_folder', {});
    if (result && result.path) {
      await setRoot(result.path, true);
      return;
    }
    state.statusLine = 'Folder selection cancelled.';
    rerender();
  }

  async function resetToDefaultRoot() {
    await setRoot(await configStore.getDefaultSessionsRoot(), false);
  }

  async function runAction(action) {
    if (action === 'refresh') await refresh();
    if (action === 'pick_folder') await pickSessionFolder();
    if (action === 'default_root') await resetToDefaultRoot();
  }

  function setupWatcher() {
    async function checkForChanges() {
      if (state.loading || state.minimized) return;
      try {
        const nextSignature = await createWatchSignature(state.sessionRoot);
        if (!lastWatchSignature) {
          lastWatchSignature = nextSignature;
          return;
        }
        if (nextSignature !== lastWatchSignature) {
          lastWatchSignature = nextSignature;
          await refresh();
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
    process.stdout.write(renderer.ansi.showCursor + renderer.ansi.reset + renderer.ansi.clear);
  }

  rerender();
  updateTitle();
  if (!state.minimized) refresh();
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
            rpc.handleRpcResponse(json);
            continue;
          }
          if (json.method === 'resize' && json.params) {
            renderer.setTerminalSize(json.params.cols, json.params.rows);
            rerender();
          } else if (json.method === 'minimize') {
            state.minimized = true;
            renderer.renderMinimized(state);
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
        if (renderer.setHoverFromMouse(cx, cy)) rerender();
        continue;
      }

      if (isRelease) continue;
      if (cb === 64) {
        refresh();
        continue;
      }
      if (cb === 65) continue;

      if (cb === 0) {
        const action = renderer.findActionAt(cx, cy);
        if (action) runAction(action);
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
        rpc.sendRpcNotify('close');
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
