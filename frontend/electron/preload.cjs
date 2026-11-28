const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("koreroDesktop", {
  applicationAudio: process.platform === "linux",
  invoke: (command, args) => ipcRenderer.invoke("korero:command", command, args),
  chooseCapture: (id, sourceId) => ipcRenderer.invoke("korero:capture-choice", id, sourceId),
  listen: (event, callback) => {
    if (!["korero:state", "korero:media", "korero:talk-shortcut", "korero:capture-sources"].includes(event)) {
      throw new Error("Unsupported desktop event.");
    }
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
