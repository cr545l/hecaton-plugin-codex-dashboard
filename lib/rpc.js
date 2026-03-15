function createRpcClient() {
  let rpcId = 1;
  const pendingRpc = new Map();

  function sendRpc(method, params) {
    const id = rpcId++;
    const rpc = JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id });
    process.stderr.write('__HECA_RPC__' + rpc + '\n');
    return new Promise((resolve) => {
      pendingRpc.set(id, resolve);
      setTimeout(() => {
        if (pendingRpc.has(id)) {
          pendingRpc.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  function sendRpcNotify(method, params) {
    const rpc = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
    process.stderr.write('__HECA_RPC__' + rpc + '\n');
  }

  function handleRpcResponse(json) {
    if (json.id != null && pendingRpc.has(json.id)) {
      const resolve = pendingRpc.get(json.id);
      pendingRpc.delete(json.id);
      resolve(json.result || null);
    }
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
