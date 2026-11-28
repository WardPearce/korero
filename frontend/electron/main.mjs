import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session, shell } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApplicationAudio } from "./application-audio.mjs";
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
let nativeTitleBar = false;
// Bounds to restore while recreating the window to switch between native and custom title bars.
let restore;
const applicationAudio = new ApplicationAudio(() => app.getAppMetrics().map(({ pid }) => pid));

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

const pendingCaptures = new Map();

function captureThumbnail(image) {
  return image && !image.isEmpty() ? `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}` : null;
}

function captureIcon(image) {
  return image && !image.isEmpty() ? image.toDataURL() : null;
}

function cancelCaptures() {
  for (const resolve of pendingCaptures.values()) resolve(null);
  pendingCaptures.clear();
}

function captureSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnail: captureThumbnail(source.thumbnail),
    icon: captureIcon(source.appIcon),
  };
}

// Thumbnails are slow to capture (notably on Windows), so the picker opens with names only and previews follow.
async function loadCapturePreviews(id, sources) {
  try {
    const previews = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true,
    });
    if (!pendingCaptures.has(id)) return;
    const known = new Set(sources.map((source) => source.id));
    sendToWindow("korero:capture-previews", {
      id,
      sources: previews.filter((source) => known.has(source.id)).map(captureSource),
    });
  } catch {
    if (pendingCaptures.has(id)) sendToWindow("korero:capture-previews", { id, sources: [] });
  }
}

function pickCapture(sources, previews) {
  cancelCaptures();
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingCaptures.set(id, resolve);
    sendToWindow("korero:capture-sources", { id, previews, sources: sources.map(captureSource) });
    if (previews) void loadCapturePreviews(id, sources);
  }).then((sourceId) => sources.find((source) => source.id === sourceId));
}

async function chooseCapture(request, callback) {
  if (!window || request.frame !== window.webContents.mainFrame || !isAppPage(request.securityOrigin) || !request.userGesture) {
    callback({});
    return;
  }
  try {
    // PipeWire presents the system picker and returns the one source it selected.
    const portal = process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const selected = !window || sources.length === 0 ? undefined
      : portal && sources.length === 1 ? sources[0]
      : await pickCapture(sources, !portal);
    callback(selected ? {
      video: selected,
      audio: request.audioRequested && process.platform !== "linux" ? "loopback" : undefined,
    } : {});
  } catch {
    callback({});
  }
}

function windowStateFile() {
  return join(app.getPath("userData"), "window.json");
}

async function readNativeTitleBar() {
  try {
    const data = JSON.parse(await readFile(windowStateFile(), "utf8"));
    return data?.nativeTitleBar === true;
  } catch {
    return false;
  }
}

async function writeNativeTitleBar(enabled) {
  try {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(windowStateFile(), JSON.stringify({ nativeTitleBar: enabled }));
  } catch {}
}

/** Switches between the native OS title bar and the custom one by recreating the window. */
async function applyNativeTitleBar(enabled) {
  if (nativeTitleBar === enabled) return;
  nativeTitleBar = enabled;
  await writeNativeTitleBar(enabled);
  if (!window || window.isDestroyed()) return;
  const bounds = window.getBounds();
  restore = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized: window.isMaximized() };
  window.close();
}

function openWindow(bounds) {
  window = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 385,
    minHeight: 600,
    autoHideMenuBar: true,
    title: "Korero.chat",
    icon: join(dist, "icon.png"),
    // Windows and Linux render their own top bar; macOS keeps the native traffic lights.
    ...(nativeTitleBar || process.platform === "darwin" ? {} : { frame: false }),
    webPreferences: {
      backgroundThrottling: false,
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (bounds?.maximized) window.maximize();
  window.on("maximize", () => sendToWindow("korero:window-state", { maximized: true }));
  window.on("unmaximize", () => sendToWindow("korero:window-state", { maximized: false }));
  const contents = window.webContents;
  const resetCaptures = () => { cancelCaptures(); applicationAudio.reset(); };
  contents.on("did-start-loading", resetCaptures);
  contents.on("render-process-gone", resetCaptures);
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
  window.once("closed", () => {
    window = undefined;
    resetCaptures();
    const next = restore;
    restore = undefined;
    if (next) openWindow(next);
  });
  void window.loadURL(appUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
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
      try {
        switch (command) {
          case "application_audio_list": return await applicationAudio.list();
          case "application_audio_start": return await applicationAudio.start(args.applications);
          case "application_audio_read": return applicationAudio.read(args.id);
          case "application_audio_stop": return applicationAudio.stop(args.id);
          default: return await desktop.invoke(command, args);
        }
      }
      finally { pendingCommands--; }
    });
    ipcMain.on("korero:window-control", (event, action) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url)) return;
      if (action === "minimize") window?.minimize();
      else if (action === "maximize") { if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); }
      else if (action === "close") window?.close();
    });
    ipcMain.handle("korero:window-maximized", (event) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url)) {
        throw new Error("Invalid desktop request.");
      }
      return window?.isMaximized() ?? false;
    });
    ipcMain.handle("korero:set-native-title-bar", async (event, enabled) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url) || typeof enabled !== "boolean") {
        throw new Error("Invalid desktop request.");
      }
      await applyNativeTitleBar(enabled);
    });
    ipcMain.handle("korero:capture-choice", (event, id, sourceId) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame?.url) ||
          typeof id !== "string" || (sourceId !== null && typeof sourceId !== "string")) {
        throw new Error("Invalid desktop request.");
      }
      const resolve = pendingCaptures.get(id);
      pendingCaptures.delete(id);
      resolve?.(sourceId);
    });
    nativeTitleBar = await readNativeTitleBar();
    openWindow();
    startUpdater();
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("window-all-closed", () => {
    if (!restore) app.quit();
  });
  app.on("before-quit", (event) => {
    if (!desktop || quitting) return;
    event.preventDefault();
    quitting = true;
    applicationAudio.reset();
    void desktop.close().finally(() => app.quit());
  });
}
