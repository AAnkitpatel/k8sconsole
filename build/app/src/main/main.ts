import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_PREFIX, INVOKE_METHODS, type EventApi, type EventName } from '../shared/api';
import type { Result } from '../shared/types';
import { AppController } from './controller';
import { contentTypeFor, resolveRendererFile } from './renderer-protocol';

const APP_NAME = 'K8sConsole';
app.setName(APP_NAME);
if (process.env.K8SC_USER_DATA_DIR) app.setPath('userData', process.env.K8SC_USER_DATA_DIR);

// The renderer is served from a custom privileged scheme instead of file:// (Electron security guidance).
const RENDERER_DIR = join(__dirname, '..', 'renderer');
const rendererUrl = 'app://renderer/index.html';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'";
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

async function serveRenderer(request: Request): Promise<Response> {
  const file = resolveRendererFile(request.url, RENDERER_DIR);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': contentTypeFor(file), 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
let mainWindow: BrowserWindow | null = null;
let controller: AppController | null = null;

function emit<E extends EventName>(event: E, payload: EventApi[E]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNEL_PREFIX + 'event:' + event, payload);
}

/** Only our own top-level renderer document may call the API. */
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return !!mainWindow && e.sender === mainWindow.webContents && !!frame && frame === mainWindow.webContents.mainFrame && frame.url.split('#')[0].split('?')[0] === rendererUrl;
}

function registerIpc(ctrl: AppController) {
  for (const method of INVOKE_METHODS) {
    ipcMain.handle(CHANNEL_PREFIX + method, async (e, ...args: unknown[]): Promise<Result<unknown>> => {
      if (!isTrustedSender(e)) return { ok: false, error: 'Untrusted sender' };
      try {
        const fn = ctrl.handlers[method] as (...a: unknown[]) => unknown;
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        const code = typeof (err as any)?.code === 'number' ? (err as any).code : undefined;
        return { ok: false, error: err instanceof Error ? err.message : String(err), code };
      }
    });
  }
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { label: 'File', submenu: [mac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])],
    },
    ...(mac ? [{ role: 'windowMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: APP_NAME,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}\n\nAn agent-free desktop console for Kubernetes and Amazon ECS.`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0f1419',
    // Shown immediately: on some Wayland compositors a window created hidden never presents its first frame.
    show: true,
    icon: join(RENDERER_DIR, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.K8SC_DEVTOOLS === '1',
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== rendererUrl) e.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(rendererUrl);
}

if (!app.requestSingleInstanceLock() && process.env.K8SC_ALLOW_MULTIPLE !== '1') {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    protocol.handle('app', serveRenderer);
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
    const keyFile = join(app.getPath('userData'), 'assistant-key.bin');
    controller = new AppController({
      secretStore: {
        available: () => safeStorage.isEncryptionAvailable(),
        get: () => {
          try {
            return existsSync(keyFile) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(keyFile)) : null;
          } catch {
            return null;
          }
        },
        set: (value) => {
          if (value === null) rmSync(keyFile, { force: true });
          else writeFileSync(keyFile, safeStorage.encryptString(value), { mode: 0o600 });
        },
      },
      userDataDir: app.getPath('userData'),
      home: homedir(),
      autosuggestPlugin: app.isPackaged ? join(process.resourcesPath, 'shell', 'zsh-autosuggestions.zsh') : join(__dirname, '..', '..', 'app', 'resources', 'shell', 'zsh-autosuggestions.zsh'),
      envKubeconfig: process.env.KUBECONFIG,
      emit,
      appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: `${process.platform}-${process.arch}` }),
      dialogs: {
        pickFile: async () => {
          const r = await dialog.showOpenDialog(mainWindow!, { title: 'Add kubeconfig file', properties: ['openFile', 'showHiddenFiles'] });
          return r.canceled ? null : r.filePaths[0] ?? null;
        },
        pickFolder: async () => {
          const r = await dialog.showOpenDialog(mainWindow!, { title: 'Add folder of kubeconfig files', properties: ['openDirectory', 'showHiddenFiles'] });
          return r.canceled ? null : r.filePaths[0] ?? null;
        },
        saveFile: async (name) => {
          const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath('downloads'), name) });
          return r.canceled ? null : r.filePath ?? null;
        },
        openExternal: (url) => shell.openExternal(url),
      },
    });
    registerIpc(controller);
    buildMenu();
    createWindow();
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.on('before-quit', () => controller?.shutdown());
  app.on('window-all-closed', () => app.quit());
}
