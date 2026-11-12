// A bare Electron window for flames.mjs to draw flame graphs in.
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => new BrowserWindow({ width: 1200, height: 800 }).loadURL("about:blank"));
