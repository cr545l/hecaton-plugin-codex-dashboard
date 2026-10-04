'use strict';

const i18n = require('./i18n');
const { PROTOCOL } = require('./hook-service');

function createHookServiceClient({ onState, onError }) {
  let channel = null;
  let closed = false;
  let established = false;
  const fail = (e) => {
    if (!closed) onError(e?.code || e?.message || String(e), e?.message || '');
  };
  const apply = (state) => { if (!closed) onState(state); };

  async function request(method = 'status', params = {}) {
    if (closed) return;
    try {
      if (!channel) {
        if (typeof hecaton.serviceChannel !== 'function') throw new Error('service_unsupported');
        channel = hecaton.serviceChannel({
          protocol: PROTOCOL,
          reason: i18n.translations('permission.reason.service_run'),
          onNotify: (method, state) => { if (method === 'state') apply(state); },
          onDisconnected: () => fail(new Error('service_disconnected')),
          onConnected: () => { if (established) request(); },
        });
      }
      await channel.connect();
      if (closed) { await channel.close(); return; }
      established = true;
      const state = await channel.request(method, params, 120000);
      apply(state);
      return state;
    } catch (e) { fail(e); }
  }

  async function close() {
    closed = true;
    if (channel) await channel.close();
  }

  return { request, close };
}

module.exports = { createHookServiceClient };
