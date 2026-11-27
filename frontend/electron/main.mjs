import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, net, protocol, session, shell } from "electron";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(directory, "../dist");
const development = !app.isPackaged && process.argv.includes("--dev");
const appUrl = development ? "http://127.0.0.1:1420/" : "korero://app/";
if (development) app.setPath("userData", join(app.getPath("appData"), "Korero.chat Dev"));
let window;
let helper;

protocol.registerSchemesAsPrivileged([{
  scheme: "korero",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

function isAppPage(url) {
  const page = URL.parse(url ?? "");
  const expected = new URL(appUrl);
  return page?.protocol === expected.protocol && page.host === expected.host && !page.username && !page.password;
}

async function serveApp(request) {
  if (!isAppPage(request.url) || request.method !== "GET") return new Response(null, { status: 404 });
  const url = new URL(request.url);
  let path;
  try {
    path = resolve(dist, "." + decodeURIComponent(url.pathname));
    const local = relative(dist, path);
    if (local.startsWith("..") || isAbsolute(local)) return new Response(null, { status: 404 });
    if ((await stat(path)).isFile()) return net.fetch(pathToFileURL(path).href);
  } catch {}
  return request.headers.get("accept")?.includes("text/html")
    ? net.fetch(pathToFileURL(join(dist, "index.html")).href)
    : new Response(null, { status: 404 });
}

function sendToWindow(event, payload) {
  if (window && !window.webContents.isDestroyed()) window.webContents.send(event, payload);
}

function startHelper() {
  const executable = process.platform === "win32" ? "desktop-client.exe" : "desktop-client";
  const path = app.isPackaged ? join(process.resourcesPath, executable)
    : resolve(directory, "../native/target", process.argv.includes("--release") ? "release" : "debug", executable);
  const processHandle = spawn(path, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let failure;
  function stop(error) {
    failure ??= error;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  }
  processHandle.once("error", (error) => stop(new Error(`Could not start the Korero.chat desktop service. ${error.message}`)));
  processHandle.once("exit", () => {
    const error = new Error("The Korero.chat desktop service stopped. Restart the app to reconnect.");
    stop(error);
    sendToWindow("korero:state", {
      phase: "error", snapshot: null, messages: [], speaking: [], voice: "idle", voiceError: null, error: error.message,
    });
  });
  processHandle.stdin.on("error", stop);
  createInterface({ input: processHandle.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === "korero:state" || message.event === "korero:talk-shortcut") {
      sendToWindow(message.event, message.payload);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (typeof message.error === "string") request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  return {
    invoke(command, args) {
      if (failure) return Promise.reject(failure);
      if (pending.size >= 128) return Promise.reject(new Error("Too many pending desktop requests."));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const line = JSON.stringify({ id, command, args }) + "\n";
        pending.set(id, { resolve, reject });
        processHandle.stdin.write(line, (error) => {
          if (error && pending.delete(id)) reject(error);
        });
      });
    },
    close() {
      processHandle.stdin.end();
      const timeout = setTimeout(() => processHandle.kill(), 3000);
      timeout.unref();
    },
  };
}

async function chooseCapture(request, callback) {
  if (!window || request.frame !== window.webContents.mainFrame || !isAppPage(request.securityOrigin) || !request.userGesture) {
    callback({});
    return;
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    // PipeWire presents the system picker and returns the one source it selected.
    const portal = process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
    const selected = await new Promise((resolve) => {
      if (!window || sources.length === 0 || (portal && sources.length === 1)) {
        resolve(window ? sources[0] : undefined);
        return;
      }
      const menu = Menu.buildFromTemplate(sources.map((source) => ({ label: source.name, click: () => resolve(source) })));
      menu.popup({ window, callback: () => resolve(undefined) });
    });
    callback(selected ? {
      video: selected,
      audio: request.audioRequested && process.platform !== "linux" ? "loopback" : undefined,
    } : {});
  } catch {
    callback({});
  }
}

function openWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 385,
    minHeight: 600,
    autoHideMenuBar: true,
    title: "Korero.chat",
    icon: join(dist, "vnx-icon.png"),
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = window.webContents;
  contents.on("will-navigate", (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const external = URL.parse(url);
    if (external && ["https:", "http:", "mailto:"].includes(external.protocol)) void shell.openExternal(external.href).catch(() => {});
    return { action: "deny" };
  });
  window.once("closed", () => { window = undefined; });
  void window.loadURL(appUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    protocol.handle("korero", serveApp);
    const appSession = session.defaultSession;
    const permissions = new Set(["media", "display-capture", "clipboard-sanitized-write"]);
    appSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(contents === window?.webContents && details.isMainFrame && isAppPage(details.requestingUrl) && permissions.has(permission)));
    appSession.setPermissionCheckHandler((contents, permission, origin, details) =>
      contents === window?.webContents && details.isMainFrame && isAppPage(origin) && permissions.has(permission));
    appSession.setDisplayMediaRequestHandler(chooseCapture, { useSystemPicker: true });
    helper = startHelper();
    ipcMain.handle("korero:command", (event, command, args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url) ||
          typeof command !== "string" || typeof args !== "object" || !args || Array.isArray(args)) {
        throw new Error("Invalid desktop request.");
      }
      return helper.invoke(command, args);
    });
    openWindow();
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => helper?.close());
}
