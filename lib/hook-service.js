'use strict';

const { createTurnBookmarks } = require('./turn-bookmarks');
const { createTurnNotifications } = require('./turn-notifications');
const { createDiagnosticLog } = require('./diagnostics');

const PROTOCOL = 2;

// One owner for the listener, dedupe maps and turn timers across all UI windows.
function createHookService({ config, onChange, sendNotification, logFile }) {
  let initialized = false;
  let queue = Promise.resolve();
  const changed = () => { if (onChange) onChange(snapshot()); };
  const diagnostics = createDiagnosticLog({ path: logFile, onChange: changed });
  const notifications = createTurnNotifications({ isEnabled: () => config.notifications !== false,
    onChange: changed, deliver: sendNotification, log: diagnostics.record });
  // Server ids are scoped to their owning host instance. Never reclaim a UI's id here.
  const bookmarks = createTurnBookmarks({ isEnabled: () => config.bookmarks !== false, notifications,
    onChange: changed, log: diagnostics.record });

  function snapshot() {
    return {
      bookmarks: { ...bookmarks.state }, notifications: { ...notifications.state },
      enabled: { bookmarks: config.bookmarks !== false, notifications: config.notifications !== false },
      diagnostics: diagnostics.snapshot(),
    };
  }

  async function reconcile() {
    if (config.bookmarks !== false || config.notifications !== false) await bookmarks.start();
    else await bookmarks.stop();
  }

  function request(method, params = {}) {
    const work = queue.then(async () => {
      if (!initialized) {
        initialized = true;
        await diagnostics.load();
        diagnostics.record('info', 'service.started', { protocol: PROTOCOL });
        await notifications.prepare();
        await reconcile();
      }
      if (method === 'configure') {
        for (const key of ['bookmarks', 'notifications']) {
          if (typeof params[key] === 'boolean') config[key] = params[key];
        }
        if (params.notifications === true) await notifications.prepare();
        await reconcile();
        changed();
      } else if (method === 'diagnostics') {
        await diagnostics.flush();
      } else if (method === 'retry') {
        await reconcile();
      } else if (method === 'status' && notifications.state.error === 'no_notification_window') {
        await notifications.prepare();
      } else if (method !== 'status') {
        throw new Error('Unknown hook service method: ' + method);
      }
      return snapshot();
    });
    queue = work.catch(() => {});
    return work;
  }

  async function shutdown() {
    await queue;
    await bookmarks.dispose();
    diagnostics.record('info', 'service.stopped');
    await diagnostics.close();
  }

  return { request, snapshot, onHttpRequest: bookmarks.onHttpRequest, shutdown, log: diagnostics.record };
}

module.exports = { PROTOCOL, createHookService };
