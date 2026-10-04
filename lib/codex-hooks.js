'use strict';
// lib/codex-hooks.js — ~/.codex/hooks.json 에 턴 북마크용 훅을 설치·점검한다
//
// Codex 의 hooks.json 은 Claude Code 와 같은 모양이다:
//   { "hooks": { "<Event>": [ { "matcher"?: "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
// 다른 도구가 넣어 둔 항목(예: SubagentStart 의 tldraw 훅)은 건드리지 않는다. 우리 항목은
// 명령에 중계기 파일 이름이 들어 있는 것으로 알아본다 — 플러그인 폴더가 옮겨져도 다시 설치하면
// 같은 항목이 새 경로로 바뀐다.
//
// notify(config.toml)는 쓰지 않는다. 명령을 하나만 받는데 Codex computer-use 가 이미 쓰고 있다.

const { joinPath } = require('./path');
const permissions = require('./permissions');

const PORT = 9219; // Claude 대시보드는 9218
const RELAY_FILE = 'codex-hook-relay.js';
// UserPromptSubmit = 턴 시작(작업 시간 계산), Stop = 응답 완료, PermissionRequest = 승인 대기,
// SessionEnd = 정리.
const EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd'];
const TIMEOUT_SEC = 5;

function relayCommand(pluginDir, event) {
  // 슬래시 경로 + 큰따옴표는 cmd·PowerShell·sh 어디서 실행돼도 같은 뜻이다.
  const relay = joinPath(pluginDir, 'lib', RELAY_FILE).replace(/\\/g, '/');
  return `node "${relay}" ${event} ${PORT}`;
}

function isOurs(hook) {
  return !!(hook && typeof hook.command === 'string' && hook.command.indexOf(RELAY_FILE) >= 0);
}

// 이벤트마다 우리 훅이 있고 명령이 지금 경로와 같은지. 반환값: 'installed' | 'stale' | 'missing'
function inspect(doc, pluginDir) {
  const hooks = (doc && doc.hooks) || {};
  let found = 0;
  let current = 0;
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const ours = groups.flatMap((g) => (Array.isArray(g && g.hooks) ? g.hooks : [])).filter(isOurs);
    if (ours.length) found++;
    if (ours.some((h) => h.command === relayCommand(pluginDir, event))) current++;
  }
  if (current === EVENTS.length) return 'installed';
  return found ? 'stale' : 'missing';
}

// 우리 항목만 지우고 다시 넣는다. 다른 훅·다른 이벤트·최상위 키는 그대로 둔다.
function merge(doc, pluginDir) {
  const out = doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc } : {};
  const hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? { ...out.hooks } : {};
  for (const event of EVENTS) {
    const groups = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    groups.push({ hooks: [{ type: 'command', command: relayCommand(pluginDir, event), timeout: TIMEOUT_SEC }] });
    hooks[event] = groups;
  }
  out.hooks = hooks;
  return out;
}

async function codexHome() {
  const envHome = ((await hecaton.env.get({ name: 'CODEX_HOME' }).catch(() => null)) || {}).value;
  if (envHome) return envHome;
  const home = (await hecaton.env.get_home()).path;
  return joinPath(home, '.codex');
}

async function hooksPath() {
  return joinPath(await codexHome(), 'hooks.json');
}

// 파일이 없으면 빈 문서. 읽을 수 없거나 JSON 이 깨졌으면 null — 덮어쓰지 않는다.
async function readDoc(path) {
  try {
    const exists = await hecaton.fs.exists({ path }).catch(() => null);
    // 거부 응답도 exists:false 를 담아 온다 — ok 를 보지 않으면 거부를 "파일 없음"으로 읽고
    // 사용자의 hooks.json 을 빈 문서로 덮어쓴다.
    if (exists && exists.ok !== false && exists.exists === false) return {};
    const result = await hecaton.fs.read_file({ path });
    if (!result || result.ok === false) return result && result.error_code === 'not_found' ? {} : null;
    return result.content.trim() ? JSON.parse(result.content) : {};
  } catch {
    return null;
  }
}

async function status(pluginDir) {
  const path = await hooksPath();
  const doc = await readDoc(path);
  return { path, state: doc ? inspect(doc, pluginDir) : 'unreadable' };
}

// 반환: { ok, path, error? }. 쓰기 거부는 tracker 에 남긴다.
async function install(pluginDir, tracker) {
  const path = await hooksPath();
  const doc = await readDoc(path);
  if (!doc) return { ok: false, path, error: 'unreadable' };
  if (!(await permissions.ensure(permissions.FS_WRITE, tracker))) return { ok: false, path, error: 'access_denied' };
  try {
    const dir = path.replace(/[\\/][^\\/]*$/, '');
    await hecaton.fs.mkdir({ path: dir, recursive: true }).catch(() => null);
    const written = await hecaton.fs.write_file({ path, content: JSON.stringify(merge(doc, pluginDir), null, 2) + '\n' });
    if (tracker) tracker.inspect(permissions.FS_WRITE, written);
    if (written && written.ok === false) return { ok: false, path, error: written.error_code || 'write_failed' };
    return { ok: true, path };
  } catch (e) {
    if (tracker && permissions.isDenied(e)) tracker.note(permissions.FS_WRITE);
    return { ok: false, path, error: (e && e.message) || 'write_failed' };
  }
}

module.exports = { PORT, EVENTS, RELAY_FILE, relayCommand, inspect, merge, status, install };
