// window.spark.antigravity: the renderer side of src/main/antigravity-cli.ts
// (whether the user's own `agy` is installed). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

export const antigravityApi = {
  installed: (): Promise<boolean> => ipcRenderer.invoke("antigravity:installed"),
};
