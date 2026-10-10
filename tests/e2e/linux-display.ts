// The Linux display flags for specs that used to pin one. By default
// (SPARK_E2E_BACKGROUND=1, set by playwright.config.ts) there are none: the app
// switches itself to Chromium's headless Ozone backend, which keeps it off the
// desktop and never waits on a Wayland compositor that refuses new clients.
// An explicit --ozone-platform on the command line would beat that switch: x11
// puts a real window on screen, and headless passed this way crashes the app
// at startup (SIGSEGV). A debugging run that wants to watch the window
// (SPARK_E2E_BACKGROUND=0) pins X11 to skip Wayland auto-detection.
export const LINUX_DISPLAY_ARGS: string[] =
  process.env.SPARK_E2E_BACKGROUND === "0" ? ["--ozone-platform=x11"] : [];
