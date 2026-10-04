'use strict';

const { createTurnBookmarks } = require('./turn-bookmarks');
const { createTurnNotifications } = require('./turn-notifications');

const PROTOCOL = 1;

// One owner for the listener, dedupe maps and turn timers across all UI windows.
function createHookService({ config, onChange }) {
  let initialized = false;
  let queue = Promise.resolve();
  const changed = () => { if (onChange) onChange(snapshot()); };
  const notifications = createTurnNotifications({ isEnabled: () => config.notifications !== false, onChange: changed });
  // Server ids are scoped to their owning host instance. Never reclaim a UI's id here.
  const bookmarks = createTurnBookmarks({ isEnabled: () => config.bookmarks !== false, notifications, onChange: changed });

  function snapshot() {
    return {
      bookmarks: { ...bookmarks.state }, notifications: { ...notifications.state },
      enabled: { bookmarks: config.bookmarks !== false, notifications: config.notifications !== false },
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
      } else if (method === 'retry') {
        await reconcile();
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
  }

  return { request, snapshot, onHttpRequest: bookmarks.onHttpRequest, shutdown };
}

module.exports = { PROTOCOL, createHookService };
