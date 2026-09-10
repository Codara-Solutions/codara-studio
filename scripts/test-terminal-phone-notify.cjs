const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-phone-notify-'));
  const context = { watching: false, dnd: false };
  globalThis.__terminalPhoneNotify = context;
  const stubs = {
    '../file-log': 'export const logMain = () => {};',
    '../orchestration/event-log': 'export const subscribeToEvents = () => () => {};',
    '../preferences-store': 'export const getPreferenceCached = () => globalThis.__terminalPhoneNotify.dnd; export const loadPreferences = async () => ({ notificationChannels: {} });',
    '../storage': 'export const cachedState = () => ({ workspaces: [] });',
    './attention': 'export const isWatchingPane = () => globalThis.__terminalPhoneNotify.watching; export const isWatchingRun = () => false; export const setAttention = () => {};',
    './deliver': 'export const deliver = () => {}; export const activeWindow = () => null; export const registerDeliveryWindow = () => {}; export const signalTerminalAttention = () => {};',
    './center-store': ['clearCenter', 'flushNotificationCenter', 'listCenterEntries', 'markCenterAllRead', 'markCenterRead', 'removeCenterEntry', 'recordToCenter'].map(name => `export const ${name} = async () => {};`).join('\n'),
  };
  try {
    const outfile = path.join(dir, 'test.cjs');
    await esbuild.build({
      stdin: { contents: 'export { publish, rearm } from "./src/main/notify"; export { subscribeDeliveredNotifications } from "./src/main/notify/subscribers"; export { phoneNotificationFromTerminalEvent } from "./src/main/remote-access/terminal-notifications"; export { phoneNotificationFromGitEvent } from "./src/main/remote-access/git-notifications";', resolveDir: root },
      outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      alias: { '@shared': path.join(root, 'src/shared') },
      plugins: [{ name: 'notify-fakes', setup(build) {
        build.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'notify-fakes' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'notify-fakes' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      } }],
    });
    const api = require(outfile);
    const received = [];
    const off = api.subscribeDeliveredNotifications(event => { const phone = api.phoneNotificationFromTerminalEvent(event) ?? api.phoneNotificationFromGitEvent(event); if (phone) received.push(phone); });
    const input = { kind: 'terminal.agent.needs-input', sourceKey: 'pane:right', title: 'Agent needs you', body: 'Allow this command?', workspaceName: 'Project', tone: 'warning', soundKind: 'needs-you', target: { type: 'terminal', workspaceId: 'ws', tabId: 'tab', paneId: 'right' } };
    api.publish(input);
    api.publish(input);
    assert.equal(received.length, 1);
    assert.equal(received[0].terminalPaneId, 'right');
    assert.equal(received[0].kind, 'blocked');
    assert.equal(received[0].body, 'Allow this command?');
    assert.equal(received[0].workspaceName, 'Project');
    api.rearm(input.sourceKey);
    context.dnd = true;
    api.publish(input);
    context.dnd = false;
    api.rearm(input.sourceKey);
    context.watching = true;
    api.publish(input);
    assert.equal(received.length, 1);
    context.watching = false;
    api.rearm(input.sourceKey);
    api.publish({ ...input, kind: 'terminal.agent.done' });
    api.publish(input);
    assert.equal(received.length, 2);
    assert.equal(received[1].kind, 'completed');
    api.rearm(input.sourceKey);
    api.publish({ ...input, kind: 'terminal.agent.failed' });
    assert.equal(received[2].kind, 'failed');
    assert.equal(api.phoneNotificationFromTerminalEvent({ ...input, kind: 'run.blocked' }), null);
    const git = { ...input, kind: 'git.pull-request', sourceKey: 'github-pr:repo#42', target: { type: 'workspace', workspaceId: 'ws', panel: 'git' } };
    api.publish(git);
    api.publish(git);
    assert.equal(received.length, 4);
    assert.equal(received[3].kind, 'github');
    assert.equal(received[3].sourceView, 'queue');
    assert.equal(received[3].workspaceId, 'ws');
    api.publish({ ...git, kind: 'git.teammate-push', sourceKey: 'github-push:repo' });
    assert.equal(received[4].sourceView, 'history');
    context.dnd = true;
    api.rearm(git.sourceKey);
    api.publish(git);
    assert.equal(received.length, 5);
    context.dnd = false;
    assert.equal(api.phoneNotificationFromGitEvent(input), null);
    assert.equal(api.phoneNotificationFromGitEvent({ ...git, target: { type: 'workspace', workspaceId: 'ws' } }), null);
    off();
    api.rearm(input.sourceKey);
    api.publish(input);
    assert.equal(received.length, 5);
    console.log('Terminal and GitHub phone notification projection, dedupe, DND, watching and completion guards passed.');
  } finally { delete globalThis.__terminalPhoneNotify; fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
