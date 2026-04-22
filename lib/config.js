const { joinPath } = require('./path');

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

  async function loadConfig() {
    try {
      const result = await hecaton.fs.read_file({ path: configFile });
      if (!result.ok) return {};
      return JSON.parse(result.content);
    } catch {
      return {};
    }
  }

  async function saveConfig(data) {
    try {
      await hecaton.fs.mkdir({ path: configDir, recursive: true });
      await hecaton.fs.write_file({ path: configFile, content: JSON.stringify(data, null, 2) });
    } catch {
      /* ignore config write errors */
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
