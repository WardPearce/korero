import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, net, protocol, session, shell } from "electron";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Desktop } from "./desktop.mjs";
import { startUpdater } from "./updater.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(directory, "../dist");
const development = !app.isPackaged && process.argv.includes("--dev");
const appUrl = development ? "http://127.0.0.1:1420/" : "korero://app/";
if (development) app.setPath("userData", join(app.getPath("appData"), "Korero.chat Dev"));
let window;
let desktop;
let quitting = false;
let pendingCommands = 0;

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
    icon: join(dist, "icon.png"),
    webPreferences: {
      backgroundThrottling: false,
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
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === "about:blank" && /^korero-screen-share-[\da-f-]{36}$/.test(frameName)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { autoHideMenuBar: true, minWidth: 320, minHeight: 240 },
      };
    }
    const external = URL.parse(url);
    if (external && ["https:", "http:", "mailto:"].includes(external.protocol)) void shell.openExternal(external.href).catch(() => {});
    return { action: "deny" };
  });
  contents.on("did-create-window", (popup) => {
    popup.webContents.on("will-navigate", (event) => event.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
    const permissions = new Set(["media", "display-capture", "speaker-selection", "clipboard-sanitized-write"]);
    appSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(contents === window?.webContents && details.isMainFrame && isAppPage(details.requestingUrl) && permissions.has(permission)));
    appSession.setPermissionCheckHandler((contents, permission, origin, details) =>
      contents === window?.webContents && details.isMainFrame && isAppPage(origin) && permissions.has(permission));
    appSession.setDisplayMediaRequestHandler(chooseCapture, { useSystemPicker: true });
    desktop = new Desktop(sendToWindow);
    ipcMain.handle("korero:command", async (event, command, args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url) ||
          typeof command !== "string" || typeof args !== "object" || !args || Array.isArray(args)) {
        throw new Error("Invalid desktop request.");
      }
      if (pendingCommands >= 128) throw new Error("Too many pending desktop requests.");
      pendingCommands++;
      try { return await desktop.invoke(command, args); }
      finally { pendingCommands--; }
    });
    openWindow();
    startUpdater();
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!desktop || quitting) return;
    event.preventDefault();
    quitting = true;
    void desktop.close().finally(() => app.quit());
  });
}
