const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("koreroDesktop", {
  applicationAudio: process.platform === "linux",
  platform: process.platform,
  invoke: (command, args) => ipcRenderer.invoke("korero:command", command, args),
  chooseCapture: (id, sourceId) => ipcRenderer.invoke("korero:capture-choice", id, sourceId),
  windowControl: (action) => ipcRenderer.send("korero:window-control", action),
  isWindowMaximized: () => ipcRenderer.invoke("korero:window-maximized"),
  setNativeTitleBar: (enabled) => ipcRenderer.invoke("korero:set-native-title-bar", enabled),
  listen: (event, callback) => {
    if (!["korero:state", "korero:media", "korero:talk-shortcut", "korero:capture-sources", "korero:capture-previews", "korero:window-state"].includes(event)) {
      throw new Error("Unsupported desktop event.");
    }
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
