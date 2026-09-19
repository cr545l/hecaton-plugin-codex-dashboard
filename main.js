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
 *
 * i18n:      locale/*.json + lib/i18n.js. 표시 언어는 호스트를 따르고 locale_changed 로 바뀐다.
 * 권한:      plugin.json 의 permission_usage_descriptions 가 프롬프트 문구, lib/permissions.js 가
 *            접근 직전 프리플라이트와 거부 표시를 맡는다.
 */

const i18n = require('./lib/i18n');
const permissions = require('./lib/permissions');
const { createConfigStore, loadPluginVersion } = require('./lib/config');
const { baseName } = require('./lib/path');
const { createRenderer } = require('./lib/render');
const { createWatchSignature, parseLatestRateLimits } = require('./lib/session-data');

const pluginDirName = (() => {
  const parts = __dirname.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'hecaton-plugin-codex-dashboard';
})();

async function main() {
  // [i18n] 0. 언어부터 — HECA_LOCALE 이 initialState.locale 로 이미 와 있으므로
  // RPC 왕복 없이 첫 프레임을 호스트 언어로 그린다.
  try { i18n.setLocale((hecaton.initialState || {}).locale); } catch { /* ignore */ }

  const pluginVersion = await loadPluginVersion(__dirname);
  const configStore = await createConfigStore(pluginDirName);
  const tracker = permissions.createTracker();
  const initialCols = parseInt(((await hecaton.env.get({ name: 'HECA_COLS' })) || {}).value || '80', 10);
  const initialRows = parseInt(((await hecaton.env.get({ name: 'HECA_ROWS' })) || {}).value || '24', 10);
  const renderer = createRenderer({
    pluginVersion,
    configFile: configStore.configFile,
    initialCols,
    initialRows,
  });

  const config = await configStore.loadConfig(tracker);
  const state = {
    loading: true,
    error: null,
    data: null,
    startTime: Date.now(),
    minimized: hecaton.initialState?.minimized ?? false,
    sessionRoot: await configStore.getSessionsRoot(config),
    usingCustomRoot: !!config.sessionRoot,
    // 상태·오류는 완성된 문자열이 아니라 {key, args} 다 — 언어가 바뀌면 같이 바뀐다.
    status: null,
    deniedPermissions: [],
    permissionStates: {},
  };

  let lastWatchSignature = '';
  let watchInterval = null;
  let clockInterval = null;

  function rerender() {
    if (state.minimized) renderer.renderMinimized(state);
    else renderer.render(state);
  }

  function updateTitle() {
    hecaton.window.set_title({
      title: i18n.t('app.windowTitle', { folder: baseName(state.sessionRoot) }),
    }).catch(() => null);
  }

  // 프롬프트를 띄우지 않는 조회. 화면의 "접근 권한" 줄에 쓴다.
  async function refreshPermissionStates() {
    const entries = await Promise.all(
      permissions.ALL.map(async (permission) => [permission, await permissions.query(permission)]),
    );
    state.permissionStates = Object.fromEntries(entries);
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    state.scanProgress = null;
    // 지난 판정을 지우고 이번 스캔의 결과만 본다 — 사용자가 설정에서 허용했는데
    // 예전 거부가 남아 경고가 계속 뜨면 안 된다.
    tracker.clear();
    rerender();

    try {
      // 접근 직전 프리플라이트: 저장된 거부는 여기서 걸리고, 처음이면 plugin.json /
      // reason 의 설명이 붙은 프롬프트가 뜬다. 거부면 스캔을 아예 시작하지 않는다.
      const canRead = await permissions.ensure(permissions.FS_READ, tracker);
      if (!canRead) {
        state.loading = false;
        state.data = null;
        state.deniedPermissions = tracker.list();
        state.status = null;          // 설명과 해결 방법은 화면 위쪽 안내가 맡는다
        await refreshPermissionStates();
        rerender();
        return;
      }
      await permissions.ensure(permissions.PROCESS_EXEC, tracker);

      state.data = await parseLatestRateLimits(state.sessionRoot, (current, total, fileName) => {
        state.scanProgress = { current, total, fileName };
        rerender();
      }, tracker);
      state.loading = false;
      state.scanProgress = null;
      state.deniedPermissions = tracker.list();
      // 거부가 섞였으면 "감시 중"이 아니라 무엇이 막혔는지부터 알린다. 데이터가 하나도
      // 없을 때는 화면 위쪽이 이미 같은 설명을 하므로 상태줄은 비운다.
      const blocked = permissions.primary(state.deniedPermissions);
      state.status = blocked
        ? (state.data ? { key: 'permission.denied.' + blocked } : null)
        : { key: 'status.watching', args: { root: state.sessionRoot } };
      rerender();
      lastWatchSignature = await createWatchSignature(state.sessionRoot, tracker);
    } catch (e) {
      state.loading = false;
      state.deniedPermissions = tracker.list();
      state.error = {
        key: 'status.scanFailed',
        args: { error: (e && e.message) || i18n.t('status.unknownError') },
      };
      state.status = { key: 'status.scanFailedHint' };
      rerender();
    }
    await refreshPermissionStates();
    rerender();
  }

  async function setRoot(nextRoot, customRoot) {
    state.sessionRoot = nextRoot;
    state.usingCustomRoot = !!customRoot;
    // 저장 판정은 스캔과 따로 모은다 — 곧 부를 refresh() 가 시작하면서 수집기를 비우므로
    // 같은 수집기를 쓰면 방금 받은 쓰기 거부가 지워진다.
    const writeTracker = permissions.createTracker();
    const saved = await configStore.saveConfig({ sessionRoot: customRoot ? nextRoot : '' }, writeTracker);
    lastWatchSignature = '';
    updateTitle();
    await refresh();
    // 저장 실패는 스캔 결과보다 먼저 알려야 한다 — 다음에 열면 폴더가 되돌아가기 때문이다.
    if (!saved) {
      const writeDenied = writeTracker.has(permissions.FS_WRITE);
      state.status = { key: writeDenied ? 'permission.denied.fs_write' : 'status.configNotSaved' };
      if (writeDenied && state.deniedPermissions.indexOf(permissions.FS_WRITE) < 0) {
        state.deniedPermissions = state.deniedPermissions.concat(permissions.FS_WRITE);
      }
    } else if (!state.deniedPermissions.length && !state.error) {
      state.status = { key: customRoot ? 'status.customFolder' : 'status.defaultFolder' };
    }
    rerender();
  }

  async function pickSessionFolder() {
    state.status = { key: 'status.pickerWaiting' };
    rerender();
    const result = await hecaton.picker.folder({}).catch(() => null);
    if (result && result.path) {
      await setRoot(result.path, true);
      return;
    }
    state.status = { key: 'status.pickerCancelled' };
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
      if (state.loading) return;
      try {
        const nextSignature = await createWatchSignature(state.sessionRoot, tracker);
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
      rerender();
    }, 30000);
  }

  function cleanup() {
    if (watchInterval) clearInterval(watchInterval);
    if (clockInterval) clearInterval(clockInterval);
    renderer.clearTooltip();
    process.stdout.write(renderer.ansi.showCursor + renderer.ansi.reset + renderer.ansi.clear);
  }

  rerender();
  updateTitle();
  refresh();
  setupWatcher();

  // 호스트가 실제로 고른 태그를 확인만 한다 — initialState 로 이미 정해져 있으므로
  // 여기서 바뀌는 경우는 드물다. 1.11 미만 호스트면 조용히 영어로 남는다.
  (async () => {
    try {
      const loc = await hecaton.i18n.get_locale().catch(() => null);
      if (loc && loc.locale && i18n.setLocale(loc.locale)) {
        updateTitle();
        rerender();
      }
    } catch { /* 1.11 미만 호스트 */ }
  })();

  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {
    /* ignore */
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  hecaton.on('window_resized', (params) => {
    renderer.setTerminalSize(params.cols, params.rows);
    rerender();
  });
  hecaton.on('window_minimized', () => {
    state.minimized = true;
    renderer.renderMinimized(state);
  });
  hecaton.on('window_restored', () => {
    state.minimized = false;
    renderer.clearTooltip();
    rerender();
    refresh();
  });
  // 사용자가 실행 중에 호스트 언어를 바꿨다 (API 1.11). 카탈로그만 갈아 끼우고
  // 창 제목까지 다시 만든다 — 문자열 폭이 통째로 달라지므로 전체를 다시 그린다.
  hecaton.on('locale_changed', (params) => {
    if (!i18n.setLocale(params && params.locale)) return;
    renderer.clearTooltip();
    updateTitle();
    state.status = { key: 'status.localeChanged', args: { locale: i18n.locale() } };
    rerender();
  });

  process.stdin.on('data', (key) => {
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
        if (state.minimized) {
          renderer.updateMinimizedTooltip(cx, cy);
          continue;
        }
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
        hecaton.window.close().catch(() => null);
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
