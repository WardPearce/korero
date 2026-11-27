const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("koreroDesktop", {
  invoke: (command, args) => ipcRenderer.invoke("korero:command", command, args),
  listen: (event, callback) => {
    if (!["korero:state", "korero:media", "korero:talk-shortcut"].includes(event)) {
      throw new Error("Unsupported desktop event.");
    }
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
