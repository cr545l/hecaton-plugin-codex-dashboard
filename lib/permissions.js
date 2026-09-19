'use strict';
// lib/permissions.js — 보호된 API 의 권한 상태와 거부 처리 (호스트 API 1.4 / reason 맵 1.15)
//
// 이 플러그인이 건드리는 보호 API 는 셋뿐이다.
//   fs_read      fs.read_dir / fs.read_file / fs.stat   — 세션 JSONL 스캔, 설정 읽기
//   fs_write     fs.write_file / fs.mkdir               — 선택한 폴더 저장
//   process_exec process.exec (tail / Get-Content)      — 세션 로그 꼬리 읽기
//
// 규칙 (호스트 권한 가이드)
//  1. 기본 설명은 plugin.json 의 permission_usage_descriptions 에 선언한다. 보호 API 가
//     자동으로 프롬프트를 띄울 때 그 문구가 그대로 보인다.
//  2. 실제로 접근하기 직전에 query → state==='prompt' 일 때만 request 한다(프리플라이트).
//     reason 은 언어별 문자열을 통째로 넘겨 호스트가 자기 표시 언어로 고르게 한다.
//  3. 결정을 존중한다. request 뒤 granted 를 보고, 그 뒤 실제 API 응답의 ok/error_code 도
//     다시 본다 — 프리플라이트 이후에 권한이 바뀔 수 있기 때문이다.
//  4. 거부를 조용히 삼키지 않는다. 거부는 "데이터 없음"이 아니라 "막혔음"으로 보여야 한다.

const i18n = require('./i18n');

const FS_READ = 'fs_read';
const FS_WRITE = 'fs_write';
const PROCESS_EXEC = 'process_exec';
const ALL = [FS_READ, FS_WRITE, PROCESS_EXEC];

// 호스트가 거부를 알리는 통로는 두 가지다 — 응답의 error_code, 그리고 던져진 오류의 code.
function isDenied(value) {
  if (!value) return false;
  const code = value.error_code || value.code || '';
  if (code === 'access_denied') return true;
  return value.ok === false && /access[_ ]denied|permission denied/i.test(String(value.error || ''));
}

// 거부된 권한을 모아 두는 수집기. 스캔 한 번이 수십 번의 RPC 로 갈라지므로 호출자마다
// 메시지를 만들지 않고 여기에 기록만 하고, 렌더는 이 목록을 읽어 한 번만 알린다.
function createTracker() {
  const denied = new Set();
  return {
    // 응답을 그대로 흘려보내며 거부만 기록한다 — 호출부 흐름을 바꾸지 않는다.
    inspect(permission, value) {
      if (isDenied(value)) denied.add(permission);
      return value;
    },
    note(permission) { denied.add(permission); },
    clear() { denied.clear(); },
    list() { return ALL.filter((p) => denied.has(p)); },
    has(permission) { return denied.has(permission); },
    get size() { return denied.size; },
  };
}

// 프롬프트를 띄우지 않는 조회. 구버전 호스트(1.4 미만)나 실패는 'unknown' 이다.
async function query(permission) {
  try {
    const r = await hecaton.permissions.query({ permission }).catch(() => null);
    if (!r) return 'unknown';
    if (r.state) return r.state;
    return r.granted === true ? 'granted' : r.granted === false ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// 접근 직전 프리플라이트. 반환값은 "지금 시도해도 되는가"다.
//  - granted           → true
//  - denied            → false (저장된 거부는 다시 물어도 프롬프트가 뜨지 않는다)
//  - prompt            → request 해서 사용자의 답을 받는다
//  - unknown/구버전    → true. 판정은 실제 API 응답에 맡긴다.
async function ensure(permission, tracker) {
  const state = await query(permission);
  if (state === 'granted') return true;
  if (state === 'denied') {
    if (tracker) tracker.note(permission);
    return false;
  }
  if (state !== 'prompt') return true;

  let result = null;
  try {
    result = await hecaton.permissions.request({
      permission,
      reason: i18n.translations('permission.reason.' + permission),
    }).catch(() => null);
  } catch {
    return true;                      // 1.4 미만 호스트 — 실제 호출 결과로 판정한다
  }
  if (!result) return true;
  if (result.granted) return true;
  if (tracker) tracker.note(permission);
  return false;
}

// 거부된 권한들을 사용자가 읽을 한 줄로. 비어 있으면 null.
function deniedSummary(permissions) {
  if (!permissions || !permissions.length) return null;
  const names = permissions.map((p) => i18n.t('permission.name.' + p)).join(', ');
  return i18n.t('permission.blocked', { names });
}

// 가장 먼저 알려야 할 거부 하나. fs_read → process_exec → fs_write 순으로
// "화면이 비는 이유"에 가까운 것부터 고른다.
function primary(permissions) {
  if (!permissions || !permissions.length) return null;
  const order = [FS_READ, PROCESS_EXEC, FS_WRITE];
  return order.find((p) => permissions.indexOf(p) >= 0) || null;
}

function primaryDenial(permissions) {
  const first = primary(permissions);
  return first ? i18n.t('permission.denied.' + first) : null;
}

// 해결 방법은 권한마다 다르다 — 폴더를 바꿔서 풀리는 것은 fs_read 뿐이다.
function deniedHint(permissions) {
  const first = primary(permissions);
  return first ? i18n.t('permission.hint.' + first) : null;
}

module.exports = {
  FS_READ,
  FS_WRITE,
  PROCESS_EXEC,
  ALL,
  isDenied,
  createTracker,
  query,
  ensure,
  deniedSummary,
  primary,
  primaryDenial,
  deniedHint,
};
