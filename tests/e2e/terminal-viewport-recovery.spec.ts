import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// This fixture exercises Chromium's native scroll events and the shipped xterm
// without launching Electron, a PTY, or an agent subscription.
test.use({ channel: process.env.SPARK_E2E_BROWSER_CHANNEL });

test("terminal reveal and focus retain scroll intent through late browser events", async ({ page }) => {
  const bundle = await build({
    stdin: {
      contents: `
        import { Terminal } from '@xterm/xterm';
        import { FitAddon } from '@xterm/addon-fit';
        import { createTerminalViewportRecovery, preserveTerminalViewport } from './src/renderer/src/components/Terminal/terminalViewport';
        const host = document.querySelector('#terminal');
        const term = new Terminal({ scrollback: 2000, allowProposedApi: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        fit.fit();
        let visible = true;
        let enabled = false;
        const recovery = createTerminalViewportRecovery(term, () => visible);
        term.onScroll(() => { if (enabled) recovery.observe(); });
        term.onWriteParsed(() => { if (enabled) recovery.observe(); });
        for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown', 'input']) {
          host.addEventListener(event, () => recovery.userInput(), { capture: true, passive: true });
        }
        const write = text => new Promise(resolve => term.write(text, resolve));
        window.viewportFixture = {
          async seed() {
            await write(Array.from({ length: 1000 }, (_, i) => 'Transcript row ' + i + '\\r\\n').join(''));
            term.scrollToBottom();
          },
          enable() { enabled = true; recovery.observe(); },
          hide() {
            visible = false;
            recovery.suspend();
            host.style.visibility = 'hidden';
          },
          async reveal() {
            visible = true;
            host.style.visibility = 'visible';
            if (enabled) recovery.recover();
            for (let i = 0; i < 3; i++) {
              await new Promise(requestAnimationFrame);
              preserveTerminalViewport(term, () => fit.fit());
              if (enabled) recovery.restore();
              else term.scrollToBottom();
            }
          },
          loseDomScroll() { host.querySelector('.xterm-viewport').scrollTop = 0; },
          history() { recovery.userInput(); term.scrollToLine(450); },
          blur() { recovery.suspend(); },
          focus() { recovery.recover(); term.focus(); },
          async redraw() {
            host.style.width = '620px';
            preserveTerminalViewport(term, () => fit.fit());
            await write('A delayed PTY redraw\\r\\n');
          },
          state() {
            const buffer = term.buffer.active;
            return { base: buffer.baseY, line: buffer.viewportY,
              domTop: host.querySelector('.xterm-viewport').scrollTop };
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent",
  });
  await page.setContent('<div id="terminal" style="width:800px;height:360px"></div>');
  await page.addStyleTag({ content: readFileSync(resolve("node_modules/@xterm/xterm/css/xterm.css"), "utf8") });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const call = (method: string) => page.evaluate((name) => (window as any).viewportFixture[name](), method);
  const state = () => page.evaluate(() => (window as any).viewportFixture.state() as { base: number; line: number; domTop: number });
  const expectBottom = async () => expect.poll(async () => {
    const current = await state();
    return current.base - current.line;
  }).toBe(0);

  await call("seed");
  await expectBottom();
  await call("hide");
  await call("reveal");
  // The previous three-frame repair has already ended when the debounced PTY
  // resize and the browser's queued scroll event arrive.
  await page.waitForTimeout(280);
  await call("loseDomScroll");
  await expect.poll(async () => (await state()).line).toBe(0);

  await call("seed");
  await call("enable");
  await call("hide");
  await call("reveal");
  await page.waitForTimeout(280);
  await call("redraw");
  await call("loseDomScroll");
  await page.waitForTimeout(80);
  await expectBottom();
  await expect.poll(async () => (await state()).domTop).toBeGreaterThan(0);

  await call("history");
  await expect.poll(async () => (await state()).line).toBe(450);
  await page.waitForTimeout(80);
  await call("blur");
  await call("loseDomScroll");
  await expect.poll(async () => (await state()).line).toBe(0);
  await call("focus");
  await expect.poll(async () => (await state()).line).toBe(450);

  await page.locator("#terminal").hover();
  await page.mouse.wheel(0, -160);
  await expect.poll(async () => (await state()).line).toBeLessThan(450);
  const afterUserScroll = (await state()).line;
  await page.waitForTimeout(550);
  expect((await state()).line).toBe(afterUserScroll);
  await call("hide");
  await call("reveal");
  expect((await state()).line).toBe(afterUserScroll);
});
