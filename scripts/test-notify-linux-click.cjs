// test-runner: heavy (boots Electron)
// Linux end to end for a native notification click: the real deliver.ts in a
// real Electron, talking libnotify to a fake org.freedesktop.Notifications on
// a private D-Bus, in a private Xvfb display.
//
//   node scripts/test-notify-linux-click.cjs
//
// The fake server answers like COSMIC's (it advertises "actions"), records
// every Notify, and clicks each notification the way a notification daemon
// does: ActivationToken, then ActionInvoked "default", then
// NotificationClosed. The checks:
//
//   - Studio asks for the "default" action, without which no click exists.
//   - The click survives a garbage collection between show and click.
//   - The click reveals the window and routes the target with its center row.
//   - On COSMIC Wayland, when the compositor keeps the window behind, the
//     click raises it through cosmic-activate with Studio's app id, and leaves
//     it alone when focus worked.
//
// Nothing reaches the desktop: the app gets its own display, bus, runtime dir
// and home, and cosmic-activate is a fake that only records its arguments.
// Linux only; elsewhere it prints SKIP. Without dbus-daemon, Xvfb, libnotify
// or python3 with GObject introspection it prints SKIP, and fails under CI.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
}

function skip(reason) {
  if (process.env.CI) {
    console.error(`FAIL cannot run on CI: ${reason}`);
    process.exit(1);
  }
  console.log(`SKIP ${reason}`);
  process.exit(0);
}

function which(name) {
  const res = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function hasLibnotify() {
  const res = spawnSync("sh", ["-c", "ldconfig -p 2>/dev/null | grep -q 'libnotify\\.so'"]);
  return res.status === 0;
}

const MOCK_SERVER = String.raw`
import json, sys
from gi.repository import Gio, GLib

XML = """<node><interface name="org.freedesktop.Notifications">
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="ActivationToken"><arg type="u"/><arg type="s"/></signal>
</interface></node>"""
PATH = "/org/freedesktop/Notifications"
IFACE = "org.freedesktop.Notifications"
CLICK_AFTER_MS = int(sys.argv[1])
node = Gio.DBusNodeInfo.new_for_xml(XML)
state = {"next": 1}

def out(**event):
    print(json.dumps(event), flush=True)

def emit(conn, name, sig, args):
    conn.emit_signal(None, PATH, IFACE, name, GLib.Variant(sig, args))

def click(conn, nid):
    emit(conn, "ActivationToken", "(us)", (nid, "token-%d" % nid))
    emit(conn, "ActionInvoked", "(us)", (nid, "default"))
    emit(conn, "NotificationClosed", "(uu)", (nid, 2))
    out(event="clicked", id=nid)
    return False

def on_call(conn, sender, path, iface, method, params, inv):
    if method == "GetCapabilities":
        inv.return_value(GLib.Variant("(as)", (["actions", "body", "body-markup", "persistence"],)))
    elif method == "GetServerInformation":
        inv.return_value(GLib.Variant("(ssss)", ("fake", "codara-test", "1", "1.2")))
    elif method == "Notify":
        app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
        nid = replaces or state["next"]
        state["next"] += 1
        out(event="notify", id=nid, summary=summary, actions=list(actions),
            desktopEntry=str(hints.get("desktop-entry", "")))
        inv.return_value(GLib.Variant("(u)", (nid,)))
        if "default" in actions:
            GLib.timeout_add(CLICK_AFTER_MS, click, conn, nid)
    elif method == "CloseNotification":
        inv.return_value(None)
    else:
        inv.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

def on_bus(conn, name):
    conn.register_object(PATH, node.interfaces[0], on_call, None, None)

Gio.bus_own_name(Gio.BusType.SESSION, IFACE, 0, on_bus, lambda c, n: out(event="ready"),
                 lambda c, n: sys.exit(2))
GLib.MainLoop().run()
`;

// The Electron side. deliver.ts is the real module; only file-log is swapped
// for stdout so the app writes nothing under a Codara home.
const MAIN_JS = String.raw`
const { app, BrowserWindow } = require("electron");
const deliver = require("./deliver.cjs");

const report = (event) => console.log("PROBE " + JSON.stringify(event));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHANNELS = { inApp: true, native: true, sound: false, osCues: false };

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

async function windowAt(x) {
  const win = new BrowserWindow({ x, y: 0, width: 400, height: 300, show: false });
  await win.loadURL("data:text/html,<p>window</p>");
  win.show();
  return win;
}

app.whenReady().then(async () => {
  const studio = await windowAt(0);
  const other = await windowAt(500);
  deliver.registerDeliveryWindow(studio);
  const routed = [];
  const send = studio.webContents.send.bind(studio.webContents);
  studio.webContents.send = (channel, ...payload) => {
    if (channel === "notify:focus") routed.push(payload);
    return send(channel, ...payload);
  };
  const focusCalls = [];
  const realFocus = studio.focus.bind(studio);
  let compositorRefuses = false;
  studio.focus = () => {
    focusCalls.push(compositorRefuses ? "refused" : "focused");
    if (!compositorRefuses) realFocus();
  };
  // Read at click time by compositor-raise.ts; set after Chromium chose its
  // display backend, which stays X11 on the private display.
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.XDG_CURRENT_DESKTOP = "COSMIC";

  const cases = [
    { name: "focus-works", refuse: false, target: { type: "run", runId: "r1", workspaceId: "w1" } },
    { name: "compositor-refuses", refuse: true, target: { type: "terminal", workspaceId: "w2", tabId: "t2", paneId: "p2" } },
  ];
  for (const [index, c] of cases.entries()) {
    other.focus();
    await waitFor(() => !studio.isFocused(), 2000);
    compositorRefuses = c.refuse;
    const before = { routed: routed.length, focus: focusCalls.length };
    const event = {
      id: "notify-" + c.name,
      kind: "terminal.agent.done",
      sourceKey: "test:" + c.name,
      title: "Claude Code finished",
      body: c.name,
      tone: "success",
      soundKind: "done",
      target: c.target,
      createdAt: new Date().toISOString(),
      workspaceName: "api-server",
    };
    const studioFocusedBefore = studio.isFocused();
    deliver.deliver(event, CHANNELS);
    global.gc();
    const clicked = await waitFor(() => routed.length > before.routed, 5000);
    // Past compositor-raise's wait, so a raise would have run by now.
    await sleep(900);
    report({
      case: c.name,
      index,
      studioFocusedBefore,
      clicked,
      route: routed[before.routed] ?? null,
      focusCalls: focusCalls.slice(before.focus),
      studioFocusedAfter: studio.isFocused(),
    });
  }
  app.exit(0);
});
setTimeout(() => {
  report({ case: "timeout" });
  process.exit(1);
}, 30000);
`;

async function bundleDeliver(dir) {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "notify", "deliver.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(dir, "deliver.cjs"),
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "linux-click-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /^\.\.\/file-log$/ }, () => ({ path: "file-log", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents:
              'export function logMain(category, message) { console.log("LOG " + JSON.stringify({ category, message })); }\n',
            loader: "js",
          }));
        },
      },
    ],
  });
}

function startBus(dir) {
  const busDir = path.join(dir, "bus");
  fs.mkdirSync(busDir);
  // No service directories: nothing on this bus can start a real portal or
  // notification daemon that would reach the desktop.
  const config = path.join(dir, "bus.conf");
  fs.writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${busDir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const daemon = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork", "--print-address=1"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("dbus-daemon printed no address")), 5000);
    daemon.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (buffer.includes("\n") && line) {
        clearTimeout(timer);
        resolve({ daemon, address: line.trim() });
      }
    });
    daemon.once("exit", (code) => reject(new Error(`dbus-daemon exited ${code}`)));
  });
}

function lines(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
}

async function main() {
  if (process.platform !== "linux") {
    console.log("SKIP Linux only (libnotify over D-Bus)");
    return;
  }
  if (!which("dbus-daemon")) skip("dbus-daemon not installed");
  if (!hasLibnotify()) skip("libnotify not installed (apt install libnotify4)");
  const gi = spawnSync("python3", ["-I", "-c", "from gi.repository import Gio, GLib"], { stdio: "ignore" });
  if (gi.status !== 0) skip("python3 GObject introspection not installed (apt install python3-gi)");

  const env = { ...process.env };
  if (!require("./virtual-display.cjs").useVirtualDisplay(env)) skip("no private X display (install Xvfb)");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-notify-linux-click-"));
  const runtimeDir = path.join(dir, "run");
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const app = path.join(dir, "app");
  for (const d of [runtimeDir, home, bin, app]) fs.mkdirSync(d, { mode: 0o700 });
  const raises = path.join(dir, "raises.log");
  fs.writeFileSync(path.join(bin, "cosmic-activate"), `#!/bin/sh\necho "$@" >> "${raises}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mock.py"), MOCK_SERVER);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "codara-studio", main: "main.js" }));
  fs.writeFileSync(path.join(app, "main.js"), MAIN_JS);
  await bundleDeliver(app);

  const { daemon, address } = await startBus(dir);
  const children = [daemon];
  const cleanup = () => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("exit", cleanup);

  const childEnv = {
    ...env,
    DBUS_SESSION_BUS_ADDRESS: address,
    XDG_RUNTIME_DIR: runtimeDir,
    HOME: home,
    PATH: `${bin}${path.delimiter}${env.PATH ?? ""}`,
    CODARA_HOME_DIR: path.join(home, ".codarastudio"),
    ELECTRON_ENABLE_LOGGING: "0",
  };
  delete childEnv.SPARK_E2E_BACKGROUND;
  delete childEnv.WAYLAND_DISPLAY;
  delete childEnv.ELECTRON_OZONE_PLATFORM_HINT;

  const serverEvents = [];
  const mock = spawn("python3", ["-I", path.join(dir, "mock.py"), "300"], {
    env: childEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(mock);
  const ready = new Promise((resolve) => {
    lines(mock.stdout, (line) => {
      try {
        const event = JSON.parse(line);
        serverEvents.push(event);
        if (event.event === "ready") resolve(true);
      } catch {}
    });
    setTimeout(() => resolve(false), 5000);
  });
  if (!(await ready)) {
    check("the fake notification server starts", false);
    process.exit(1);
  }

  const electron = require("electron");
  const probes = [];
  const logs = [];
  let stderr = "";
  const exitCode = await new Promise((resolve) => {
    const child = spawn(
      electron,
      [app, "--no-sandbox", "--ozone-platform=x11", "--js-flags=--expose-gc", "--disable-gpu"],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    lines(child.stdout, (line) => {
      if (line.startsWith("PROBE ")) probes.push(JSON.parse(line.slice(6)));
      if (line.startsWith("LOG ")) logs.push(JSON.parse(line.slice(4)));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("exit", (code) => resolve(code));
  });
  cleanup();

  const byCase = Object.fromEntries(probes.map((p) => [p.case, p]));
  if (exitCode !== 0 || !byCase["focus-works"] || !byCase["compositor-refuses"]) {
    check("the Electron probe ran both cases", false, `exit ${exitCode}; probes ${JSON.stringify(probes)}\n${stderr}`);
    process.exit(1);
  }
  const notifies = serverEvents.filter((e) => e.event === "notify");
  const raised = fs.existsSync(raises) ? fs.readFileSync(raises, "utf8").trim().split("\n").filter(Boolean) : [];

  check(
    "Studio's notification carries the default action",
    notifies.length === 2 && notifies.every((n) => n.actions.includes("default")),
    JSON.stringify(notifies),
  );
  check("the title says which workspace it came from", notifies[0]?.summary === "Claude Code finished · api-server");
  check("the server sees Studio's desktop entry", notifies[0]?.desktopEntry === "codara-studio");
  check("the server clicked both", serverEvents.filter((e) => e.event === "clicked").length === 2);

  const works = byCase["focus-works"];
  check("Studio was in the background when the alert came", works.studioFocusedBefore === false);
  check("a D-Bus click reaches Studio after a garbage collection", works.clicked === true);
  check(
    "the click routes the target with its center row",
    JSON.stringify(works.route) === JSON.stringify([{ type: "run", runId: "r1", workspaceId: "w1" }, "notify-focus-works"]),
    JSON.stringify(works.route),
  );
  check("the click focuses the window", works.focusCalls.includes("focused") && works.studioFocusedAfter === true);
  check(
    "the click is logged",
    logs.some((l) => l.message.startsWith("native click id=notify-focus-works")),
  );

  const refused = byCase["compositor-refuses"];
  check("a refused focus still opens the target", refused.clicked === true && refused.route?.[1] === "notify-compositor-refuses");
  check("the window was asked to focus", refused.focusCalls.includes("refused"));
  check(
    "a window the compositor kept behind is raised through cosmic-activate",
    raised.length === 1 && raised[0] === "codara-studio",
    `cosmic-activate calls: ${JSON.stringify(raised)}`,
  );
  check(
    "the raise is logged",
    logs.some((l) => l.message.startsWith("id=notify-compositor-refuses") && l.message.includes("cosmic-activate codara-studio")),
  );

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} notify-linux-click check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll notify-linux-click checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
