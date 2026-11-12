// Screenshots each card's page with headless Chrome over the DevTools protocol, so the
// build needs no npm packages. Images land in thumbs/<id>.webp; data/thumbs.json records
// when each was taken, and a card is re-shot whenever its repo has been pushed since.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const THUMB_WIDTH = 600; // stored width; cards display at roughly half this
const DEFAULT_SHOT = { width: 800, height: 600, delay: 2500 };

async function launch() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shots-'));
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-swiftshader',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.on('exit', () => reject(new Error('Chrome exited')));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId && { sessionId }) }));
    });
  const waitFor = (method, sessionId, ms) =>
    new Promise((resolve) => {
      const fn = (m) => {
        if (m.method === method && m.sessionId === sessionId) done(true);
      };
      const timer = setTimeout(() => done(false), ms);
      const done = (ok) => {
        clearTimeout(timer);
        listeners.delete(fn);
        resolve(ok);
      };
      listeners.add(fn);
    });

  return {
    async shoot(url, opts) {
      const { width, height, delay } = { ...DEFAULT_SHOT, ...opts };
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      try {
        await send('Page.enable', {}, sessionId);
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
        const loaded = waitFor('Page.loadEventFired', sessionId, 30000);
        await send('Page.navigate', { url }, sessionId);
        await loaded;
        await new Promise((r) => setTimeout(r, delay));
        const { data } = await send(
          'Page.captureScreenshot',
          { format: 'webp', quality: 82, clip: { x: 0, y: 0, width, height, scale: THUMB_WIDTH / width } },
          sessionId,
        );
        return Buffer.from(data, 'base64');
      } finally {
        await send('Target.closeTarget', { targetId }).catch(() => {});
      }
    },
    async close() {
      ws.close();
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// cards: [{ id, url, updated, shot }]. Returns the set of ids that have a thumbnail.
// force: true re-shoots everything; an array of ids re-shoots just those.
export async function updateThumbs(root, cards, { force = false, log = console.log } = {}) {
  const dir = path.join(root, 'thumbs');
  const manifestPath = path.join(root, 'data', 'thumbs.json');
  await mkdir(dir, { recursive: true });
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {}

  // shot: { none: true } keeps a card on a placeholder (e.g. a page showing student photos).
  const shootable = cards.filter((c) => !c.shot?.none);
  const keep = new Set(shootable.map((c) => `${c.id}.webp`));
  for (const f of await readdir(dir)) if (f.endsWith('.webp') && !keep.has(f)) await rm(path.join(dir, f));

  const has = (c) => existsSync(path.join(dir, `${c.id}.webp`));
  const stale = (c) =>
    force === true ||
    (Array.isArray(force) && force.includes(c.id)) ||
    !has(c) ||
    manifest[c.id]?.url !== c.url ||
    (c.updated && manifest[c.id]?.taken < c.updated);
  const todo = shootable.filter(stale);

  if (todo.length && process.env.SKIP_SHOTS !== '1') {
    let browser = null;
    try {
      browser = await launch();
      if (!browser) log('Screenshots skipped: no Chrome found (set CHROME_PATH).');
    } catch (e) {
      log(`Screenshots skipped: ${e.message}`);
    }
    if (browser) {
      for (const c of todo) {
        try {
          const img = await browser.shoot(c.url, c.shot);
          await writeFile(path.join(dir, `${c.id}.webp`), img);
          manifest[c.id] = { url: c.url, taken: new Date().toISOString() };
          log(`- Screenshot: ${c.id}`);
        } catch (e) {
          log(`- Screenshot failed for ${c.id} (${c.url}): ${e.message}`);
        }
      }
      await browser.close();
    }
  }

  for (const k of Object.keys(manifest)) if (!keep.has(`${k}.webp`)) delete manifest[k];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return new Set(shootable.filter(has).map((c) => c.id));
}
