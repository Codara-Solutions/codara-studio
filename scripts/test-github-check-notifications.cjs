const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-check-notify-'));
  try {
    const outfile = path.join(dir, 'test.cjs');
    await esbuild.build({ entryPoints: [path.join(__dirname, '../src/main/remote-access/github-check-notifications.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { GitHubCheckNotifications, startGitHubCheckNotifications, GITHUB_CHECK_POLL_MS } = require(outfile);
    let time = Date.parse('2026-09-09T10:00:00Z');
    const checks = (successful, failed = 0, pending = 0) => ({ total: successful + failed + pending, successful, failed, pending });
    const item = (check, overrides = {}) => ({ kind: 'pull-request', key: 'repo#42', repository: 'owner/repo', repositoryUrl: 'https://github.com/owner/repo', sourceWorkspaceId: 'ws', pullRequest: { number: 42, title: 'Fix reconnection', state: 'OPEN', headCommitOid: 'a'.repeat(40), checks: check, ...overrides } });
    const snapshot = (items) => ({ kind: 'ready', refreshedAt: new Date(time += 1_000).toISOString(), items, errors: [], truncated: {} });
    const tracker = new GitHubCheckNotifications();
    assert.deepEqual(tracker.update(snapshot([item(checks(0, 0, 2))])), []);
    let events = tracker.update(snapshot([item(checks(1, 1))]));
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'PR #42: checks failed');
    assert.equal(events[0].sourceView, 'queue');
    assert.equal(events[0].workspaceId, 'ws');
    assert.equal(events[0].kind, 'github');
    assert.match(events[0].body, /owner\/repo: Fix reconnection/);
    assert.equal(tracker.update(snapshot([item(checks(1, 1))])).length, 0);
    assert.equal(tracker.update({ kind: 'error', message: 'offline' }).length, 0);
    assert.equal(tracker.update(snapshot([])).length, 0);
    assert.equal(tracker.update(snapshot([item(checks(0, 0, 2))])).length, 0);
    events = tracker.update(snapshot([item(checks(2))]));
    assert.equal(events[0].title, 'PR #42: checks passed');
    const passed = snapshot([item(checks(2))]);
    assert.equal(tracker.update(passed).length, 0);
    const old = { ...passed, refreshedAt: '2026-09-09T09:00:00Z', items: [item(checks(0, 1))] };
    assert.deepEqual(tracker.update(old), []);
    events = tracker.update(snapshot([item(checks(2), { headCommitOid: 'b'.repeat(40) })]));
    assert.equal(events.length, 1, 'a new head can finish between polls');
    assert.equal(tracker.update(snapshot([item(checks(0), { headCommitOid: 'b'.repeat(40) })])).length, 0);
    assert.equal(tracker.update(snapshot([item(checks(1), { headCommitOid: 'b'.repeat(40) })])).length, 1);
    tracker.reset();
    assert.deepEqual(tracker.update(snapshot([item(checks(2))])), [], 'enabling or restarting does not replay old results');
    assert.deepEqual(tracker.update(snapshot([item(checks(0, 1), { state: 'MERGED' })])), []);
    assert.deepEqual(tracker.update(snapshot([item(checks(0, 1), { headCommitOid: '' })])), []);
    assert.deepEqual(tracker.update(snapshot([item({ total: 2, successful: -1, failed: 1, pending: 2 })])), []);
    assert.deepEqual(tracker.update(snapshot([item({ total: 1, successful: 1, failed: 1, pending: 0 })])), []);
    const many = Array.from({ length: 300 }, (_, i) => item(checks(1), { number: i + 100 }));
    tracker.update(snapshot(many));
    assert.deepEqual(tracker.update(snapshot([item(checks(0, 1))])), [], 'old PRs are evicted from bounded tracking');

    let scheduled = null;
    let enabled = true;
    let muted = false;
    let readCount = 0;
    let current = snapshot([item(checks(0, 0, 2))]);
    let pendingRead = null;
    const delivered = [];
    const stop = startGitHubCheckNotifications({
      enabled: async () => enabled,
      muted: () => muted,
      read: async () => { readCount += 1; return pendingRead ?? current; },
      deliver: async (event) => { delivered.push(event); },
      schedule: (callback, delay) => {
        assert.equal(scheduled, null, 'never overlap polls');
        scheduled = { callback, delay };
        return () => { scheduled = null; };
      },
      log: () => {},
    });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    async function tick() { const next = scheduled; assert.ok(next); scheduled = null; next.callback(); await flush(); }
    assert.equal(scheduled.delay, 20_000);
    await tick();
    assert.equal(delivered.length, 0);
    assert.equal(scheduled.delay, GITHUB_CHECK_POLL_MS);
    current = snapshot([item(checks(1, 1))]);
    await tick();
    assert.equal(delivered.length, 1);
    await tick();
    assert.equal(delivered.length, 1);
    current = snapshot([item(checks(2))]);
    muted = true;
    await tick();
    muted = false;
    await tick();
    assert.equal(delivered.length, 1, 'DND results are not replayed');
    enabled = false;
    const before = readCount;
    await tick();
    assert.equal(readCount, before, 'disabled phones cause no GitHub read');
    enabled = true;
    current = snapshot([item(checks(0, 1))]);
    await tick();
    assert.equal(delivered.length, 1, 're-enabling baselines without a storm');
    current = { kind: 'not-authenticated', message: 'sign in' };
    await tick();
    assert.equal(scheduled.delay, GITHUB_CHECK_POLL_MS * 2);
    await tick();
    assert.equal(scheduled.delay, GITHUB_CHECK_POLL_MS * 4);
    let resolve;
    pendingRead = new Promise((yes) => { resolve = yes; });
    await tick();
    assert.equal(scheduled, null, 'slow reads cannot overlap');
    enabled = false;
    resolve(snapshot([item(checks(2))]));
    await flush();
    assert.equal(delivered.length, 1, 'disabling while reading cancels the result');
    stop();
    assert.equal(scheduled, null);
    console.log('GitHub check transitions, baselines, bounded state, disabled delivery, DND, backoff and serial polling passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
