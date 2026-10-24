// Imported first by index.ts, so it runs before electron-updater or any other
// module can read an AppImage launch this process only inherited.
import { clearInheritedAppImageLaunch } from "./appimage-launch";

clearInheritedAppImageLaunch(process.env, process.execPath);
