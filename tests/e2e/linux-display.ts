// The Linux display backend for specs that pin one. Both choices skip
// Chromium's Wayland auto-detection, which can hang the whole app when the
// compositor refuses new clients (headless CI, stale sessions). Headless also
// keeps the app off the desktop of whoever runs the suite; it is the default
// because playwright.config.ts runs every spec with SPARK_E2E_BACKGROUND=1. An
// explicit --ozone-platform on the command line wins over the switch the app
// sets for itself, so a pinned x11 would put a real window on screen. A
// debugging run that wants to watch (SPARK_E2E_BACKGROUND=0) keeps X11.
export const LINUX_DISPLAY_ARG =
  process.env.SPARK_E2E_BACKGROUND === "0" ? "--ozone-platform=x11" : "--ozone-platform=headless";
