'use strict';

// Some Hecaton versions require notify.send's caller to own a terminal even
// when terminal_id is explicit. A service has none; a connected UI does.
function createNotificationDelivery(host) {
  let needsWindow = false;

  async function send(payload) {
    if (!needsWindow) {
      try {
        const result = await hecaton.notify.send(payload);
        if (result?.error_code !== 'no_terminal') return result;
      } catch (e) {
        if (e?.code !== 'no_terminal') throw e;
      }
      needsWindow = true;
    }
    for (const link of host.clients().slice().reverse()) {
      try {
        const result = await host.request(link, 'notify.send', payload, 120000);
        // A served UI may also lack its own terminal; try another local UI.
        if (result?.error_code === 'no_terminal') continue;
        return result;
      } catch (e) {
        // Do not repeat an ambiguous delivery after a timeout/disconnection.
        return { ok: false, error_code: e?.code || 'notification_delivery_failed', error: e?.message || String(e) };
      }
    }
    return { ok: false, error_code: 'no_notification_window' };
  }

  return { send };
}

module.exports = { createNotificationDelivery };
