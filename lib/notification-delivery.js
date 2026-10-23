'use strict';

const { errorDetails } = require('./diagnostics');

// Some Hecaton versions require notify.send's caller to own a terminal even
// when terminal_id is explicit. A service has none; a connected UI does.
function createNotificationDelivery(host, { log = () => {} } = {}) {
  let needsWindow = false;

  async function send(payload, context = {}) {
    const details = { ...context, terminal_id: payload.terminal_id };
    if (!needsWindow) {
      try {
        const result = await hecaton.notify.send(payload);
        if (result?.error_code !== 'no_terminal') return result;
        log('warn', 'notification.service_fallback', { ...details, error: errorDetails(result) });
      } catch (e) {
        if (e?.code !== 'no_terminal') throw e;
        log('warn', 'notification.service_fallback', { ...details, error: errorDetails(e) });
      }
      needsWindow = true;
    }
    for (const link of host.clients().slice().reverse()) {
      try {
        log('info', 'notification.ui_delivery', { ...details, link_id: link });
        const result = await host.request(link, 'notify.send', payload, 120000);
        // A served UI may also lack its own terminal; try another local UI.
        if (result?.error_code === 'no_terminal') {
          log('warn', 'notification.ui_skipped', { ...details, link_id: link, error: errorDetails(result) });
          continue;
        }
        return result;
      } catch (e) {
        log('error', 'notification.ui_failed', { ...details, link_id: link, error: errorDetails(e) });
        // Do not repeat an ambiguous delivery after a timeout/disconnection.
        return { ok: false, error_code: e?.code || 'notification_delivery_failed', error: e?.message || String(e) };
      }
    }
    return { ok: false, error_code: 'no_notification_window' };
  }

  return { send };
}

module.exports = { createNotificationDelivery };
