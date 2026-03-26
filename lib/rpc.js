function createRpcClient() {
  function sendRpc(method, params) {
    return hecaton[method](params || {}).then(r => r || null).catch(() => null);
  }

  function sendRpcNotify(method, params) {
    hecaton[method](params || {}).catch(() => {});
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
