import type { BridgeApi, EventApi, EventName, InvokeApi, InvokeMethod } from '../../shared/api';

declare global {
  interface Window {
    k8sc: BridgeApi;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Calls a main-process method and unwraps the Result, throwing ApiError on failure. */
export async function call<M extends InvokeMethod>(method: M, ...args: Parameters<InvokeApi[M]>): Promise<Awaited<ReturnType<InvokeApi[M]>>> {
  const r = await window.k8sc.invoke(method, ...args);
  if (!r.ok) throw new ApiError(r.error, r.code);
  return r.value as Awaited<ReturnType<InvokeApi[M]>>;
}

export function on<E extends EventName>(event: E, listener: (p: EventApi[E]) => void): () => void {
  return window.k8sc.on(event, listener);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
