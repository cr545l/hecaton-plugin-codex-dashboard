const { joinPath } = require('./path');
const permissions = require('./permissions');

async function loadPluginVersion(pluginDir) {
  try {
    const result = await hecaton.fs.read_file({ path: joinPath(pluginDir, 'plugin.json') });
    return result.ok ? JSON.parse(result.content).version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

async function createConfigStore(pluginDirName) {
  const home = (await hecaton.env.get_home()).path;
  const configDir = joinPath(home, '.hecaton', 'data', pluginDirName);
  const configFile = joinPath(configDir, 'config.json');

  async function loadConfig(tracker) {
    try {
      const result = await hecaton.fs.read_file({ path: configFile });
      if (tracker) tracker.inspect(permissions.FS_READ, result);
      if (!result.ok) return {};
      return JSON.parse(result.content);
    } catch (e) {
      if (tracker && permissions.isDenied(e)) tracker.note(permissions.FS_READ);
      return {};
    }
  }

  // 저장 실패를 조용히 삼키지 않는다 — 폴더 선택이 기억되지 않는다는 것은
  // 사용자가 알아야 하는 사실이다. 반환값으로 알리고, 거부는 tracker 에 남긴다.
  async function saveConfig(data, tracker) {
    if (!(await permissions.ensure(permissions.FS_WRITE, tracker))) return false;
    try {
      const made = await hecaton.fs.mkdir({ path: configDir, recursive: true });
      if (tracker) tracker.inspect(permissions.FS_WRITE, made);
      const written = await hecaton.fs.write_file({
        path: configFile,
        content: JSON.stringify(data, null, 2),
      });
      if (tracker) tracker.inspect(permissions.FS_WRITE, written);
      return !!(written && written.ok !== false);
    } catch (e) {
      if (tracker && permissions.isDenied(e)) tracker.note(permissions.FS_WRITE);
      return false;
    }
  }

  async function getDefaultSessionsRoot() {
    const envHome = ((await hecaton.env.get({ name: 'CODEX_HOME' })) || {}).value;
    const homeDir = (await hecaton.env.get_home()).path;
    if (envHome) return joinPath(envHome, 'sessions');
    return joinPath(homeDir, '.codex', 'sessions');
  }

  async function getSessionsRoot(config) {
    if (config && config.sessionRoot) return config.sessionRoot;
    return await getDefaultSessionsRoot();
  }

  return {
    configDir,
    configFile,
    loadConfig,
    saveConfig,
    getDefaultSessionsRoot,
    getSessionsRoot,
  };
}

module.exports = {
  loadPluginVersion,
  createConfigStore,
};
