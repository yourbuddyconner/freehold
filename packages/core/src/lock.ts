/**
 * Per-graph async mutex.  AllodGraph is a wasm object whose mutating methods
 * hold a Rust &mut borrow across an internal await of the persist callback;
 * any other call into the same graph during that window throws a wasm-bindgen
 * aliasing error.  Every operation that touches a graph must run through
 * withGraph so calls are strictly serialized.
 */
const chains = new WeakMap<object, Promise<unknown>>();

export function withGraph<T>(graph: object, fn: () => T | Promise<T>): Promise<T> {
  const prev = chains.get(graph) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    graph,
    run.catch(() => {})
  );
  return run;
}
