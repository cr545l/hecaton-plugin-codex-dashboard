function createRpcClient() {
  function resolveMethod(method) {
    const parts = String(method).split('.');
    let ctx = hecaton;
    let fn = hecaton;
    for (let i = 0; i < parts.length; i++) {
      if (fn == null) return { ctx: null, fn: null };
      ctx = fn;
      fn = fn[parts[i]];
    }
    return { ctx, fn };
  }

  function sendRpc(method, params) {
    const { ctx, fn } = resolveMethod(method);
    if (typeof fn !== 'function') return Promise.resolve(null);
    return fn.call(ctx, params || {}).then(r => r || null).catch(() => null);
  }

  function sendRpcNotify(method, params) {
    const { ctx, fn } = resolveMethod(method);
    if (typeof fn !== 'function') return;
    try {
      const res = fn.call(ctx, params || {});
      if (res && typeof res.catch === 'function') res.catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function handleRpcResponse() {
    // No longer needed — deno runner handles RPC responses internally
  }

  return {
    sendRpc,
    sendRpcNotify,
    handleRpcResponse,
  };
}

module.exports = {
  createRpcClient,
};
