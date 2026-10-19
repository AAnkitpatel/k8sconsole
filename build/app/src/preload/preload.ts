import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNEL_PREFIX, EVENT_NAMES, INVOKE_METHODS, type BridgeApi } from '../shared/api';

const allowedMethods = new Set<string>(INVOKE_METHODS);
const allowedEvents = new Set<string>(EVENT_NAMES);

// Only a fixed list of channels is reachable; the raw ipcRenderer is never exposed.
const api: BridgeApi = {
  invoke(method, ...args) {
    if (!allowedMethods.has(method)) return Promise.resolve({ ok: false, error: `Unknown method ${String(method)}` });
    return ipcRenderer.invoke(CHANNEL_PREFIX + method, ...args);
  },
  on(event, listener) {
    if (!allowedEvents.has(event)) throw new Error(`Unknown event ${String(event)}`);
    const channel = CHANNEL_PREFIX + 'event:' + event;
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('k8sc', api);
