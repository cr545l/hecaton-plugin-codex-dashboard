'use strict';

const i18n = require('./lib/i18n');
const { createConfigStore } = require('./lib/config');
const { PROTOCOL, createHookService } = require('./lib/hook-service');

async function main() {
  i18n.setLocale(hecaton.initialState?.locale);
  const store = await createConfigStore('dev.hecaton.codex-dashboard');
  const config = await store.loadConfig();
  let core;
  const host = hecaton.serviceHost({
    protocol: PROTOCOL,
    onRequest: (_link, method, params) => core.request(method, params),
  });
  core = createHookService({ config, onChange: (state) => host.broadcast('state', state).catch(() => {}) });
  hecaton.on('http_request_received', core.onHttpRequest);
  hecaton.on('locale_changed', (params) => i18n.setLocale(params?.locale));
  hecaton.onShutdown(() => core.shutdown(), { graceMs: 4000 });
  await host.listen();
}

main().catch((e) => console.error('[codex-hook-service] ' + (e.stack || e)));
