#!/usr/bin/env node
// Rebuilds index.html: a directory of every website published from the owner's public
// GitHub repositories. Names, summaries and links come from data/sites.json; anything
// that file doesn't mention (a new repo, a new page in a known repo) is discovered
// through the GitHub API and listed automatically.
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'data', 'sites.json'), 'utf8'));
const OWNER = config.owner;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const report = { newRepos: [], newPages: [], broken: [], noSite: [] };

// ---------- fetching ----------

async function api(p) {
  const res = await fetch(`https://api.github.com/${p}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${OWNER}-site-directory`,
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${p}`);
  return res.json();
}

async function listRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await api(`users/${OWNER}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

// Runs fn over items with at most `limit` calls in flight, preserving order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function isLive(url) {
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.status === 405) res = await fetch(url, { redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m,
  );

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Reads only the first 64 KB: some pages embed megabytes of base64 after the <head>.
async function fetchTitle(repo, branch, p) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/${encodeURI(branch)}/${encodePath(p)}`, {
      headers: { Range: 'bytes=0-65535' },
    });
    if (!res.ok) return '';
    const m = (await res.text()).match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

// ---------- paths ----------

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// "" and "dir/" name the index page of that directory.
const normalize = (p) => {
  p = p.replace(/^\.?\//, '');
  return p === '' || p.endsWith('/') ? `${p}index.html` : p;
};

const pageUrl = (base, p) => base + encodePath(normalize(p).replace(/(^|\/)index\.html$/i, '$1'));

const fallbackLabel = (p) =>
  normalize(p)
    .replace(/\/?index\.html?$/i, '')
    .split('/')
    .pop()
    .replace(/\.html?$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

const stripTitle = (title, patterns) => patterns.reduce((t, p) => t.replace(new RegExp(p), ''), title).trim();

// ---------- discovery ----------

async function describe(repo) {
  const cur = config.repos[repo.name];
  let base = null;
  let branch = repo.default_branch;
  let siteRoot = '';
  let files = [];

  if (repo.has_pages) {
    base = `https://${OWNER}.github.io/${repo.name}/`;
    try {
      const site = await api(`repos/${OWNER}/${repo.name}/pages`);
      if (site.html_url) base = site.html_url.replace(/\/?$/, '/');
      if (site.source?.branch) branch = site.source.branch;
      if (site.source?.path === '/docs') siteRoot = 'docs/';
    } catch {
      // The Actions token can't read other repos' Pages settings; guess the source branch.
      try {
        await api(`repos/${OWNER}/${repo.name}/branches/gh-pages`);
        branch = 'gh-pages';
      } catch {}
    }
    try {
      const tree = await api(`repos/${OWNER}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      files = tree.tree
        .filter((t) => t.type === 'blob' && t.path.startsWith(siteRoot))
        .map((t) => t.path.slice(siteRoot.length));
    } catch {}
  } else if (repo.homepage) {
    base = repo.homepage.replace(/\/?$/, '/');
  }

  if (!base) {
    report.noSite.push(repo.name);
    return { kind: 'nosite', repo };
  }

  const ignore = [...(config.ignore || []), ...(cur?.ignore || [])].map(globToRegExp);
  const pages = files.filter((f) => /\.html?$/i.test(f) && !ignore.some((re) => re.test(f)));
  const strip = [...(config.stripTitle || []), ...(cur?.stripTitle || [])];
  const titleOf = async (p) => stripTitle(await fetchTitle(repo.name, branch, siteRoot + normalize(p)), strip);

  const primaryPath = cur ? cur.primary ?? '' : pages.find((p) => /^index\.html?$/i.test(p)) ?? pages[0] ?? '';
  const primaryUrl = pageUrl(base, primaryPath);
  const linkDefs = cur?.links || [];
  const known = new Set([normalize(primaryPath), ...linkDefs.map((l) => normalize(l.path))]);

  const links = await mapLimit(linkDefs, 6, async (l) => {
    const url = pageUrl(base, l.path);
    if (!(await isLive(url))) report.broken.push(url);
    return { label: l.label || (await titleOf(l.path)) || fallbackLabel(l.path), url, group: l.group || '' };
  });
  if (!(await isLive(primaryUrl))) report.broken.push(primaryUrl);

  const extras = (
    await mapLimit(
      pages.filter((p) => !known.has(p)),
      6,
      async (p) => {
        const url = pageUrl(base, p);
        if (!(await isLive(url))) return null;
        return { label: (await titleOf(p)) || fallbackLabel(p), url, path: p };
      },
    )
  ).filter(Boolean);

  if (!cur) report.newRepos.push(repo.name);
  else extras.forEach((e) => report.newPages.push(`${repo.name}/${e.path}`));

  const discoveredName = cur ? '' : (primaryPath && (await titleOf(primaryPath))) || repo.name.replace(/[-_]+/g, ' ');
  return {
    kind: 'site',
    isNew: !cur,
    name: cur?.name || discoveredName,
    summary: cur?.summary || repo.description || '',
    category: cur?.category || 'new',
    repoName: repo.name,
    repoUrl: repo.html_url,
    updated: repo.pushed_at,
    primaryUrl,
    links,
    extras,
  };
}

// ---------- rendering ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortUrl = (u) => decodeURI(u).replace(/^https?:\/\//, '').replace(/\/$/, '');

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const SEARCH_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8.5 15a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm4.8-1.7L18 18"/></svg>';

const chips = (items) => `<ul class="chips">${items.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join('')}</ul>`;

function renderGroup(title, items) {
  if (!items.length) return '';
  if (items.length > 8) {
    const list = items.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join('');
    return `<details class="group"><summary>${esc(title)} <span class="count">${items.length}</span></summary><ol class="list">${list}</ol></details>`;
  }
  return `<div class="group"><p class="group-label">${esc(title)}</p>${chips(items)}</div>`;
}

function renderCard(e) {
  const loose = e.links.filter((l) => !l.group);
  const groups = [...new Set(e.links.map((l) => l.group).filter(Boolean))];
  const search = [e.name, e.summary, e.repoName, ...e.links.map((l) => l.label), ...e.extras.map((l) => l.label)].join(' ').toLowerCase();
  return `
        <article class="card" data-search="${esc(search)}">
          <h3><a href="${esc(e.primaryUrl)}">${esc(e.name)}</a>${e.isNew ? ' <span class="badge">New</span>' : ''}</h3>
          <p class="url">${esc(shortUrl(e.primaryUrl))}</p>
          ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ''}
          ${loose.length ? chips(loose) : ''}
          ${groups.map((g) => renderGroup(g, e.links.filter((l) => l.group === g))).join('\n          ')}
          ${renderGroup(e.isNew ? 'Pages' : 'More pages', e.extras)}
          <footer><a href="${esc(e.repoUrl)}">${GITHUB_ICON}<span>${esc(`${OWNER}/${e.repoName}`)}</span></a><span>Updated ${fmtDate(e.updated)}</span></footer>
        </article>`;
}

function renderPage(sites, bare) {
  const categories = [
    { id: 'new', name: 'Just added', blurb: 'New sites found since this directory was last curated.' },
    ...config.categories,
  ];
  for (const s of sites) {
    if (!categories.some((c) => c.id === s.category)) categories.push({ id: s.category, name: s.category, blurb: '' });
  }
  const filled = categories.filter((c) => sites.some((s) => s.category === c.id));
  const pageCount = sites.reduce((n, s) => n + 1 + s.links.length + s.extras.length, 0);
  const latest = sites.map((s) => s.updated).sort().at(-1);
  const color = (id) => (['new', 'courses', 'activities', 'tools', 'personal'].includes(id) ? `var(--${id})` : 'var(--muted)');
  const title = `${config.ownerName} · Sites & Apps`;

  const sections = filled
    .map(
      (c) => `
    <section class="cat" id="${esc(c.id)}" style="--cat:${color(c.id)}">
      <h2><span class="dot"></span>${esc(c.name)}</h2>
      ${c.blurb ? `<p>${esc(c.blurb)}</p>` : ''}
      <div class="grid">${sites
        .filter((s) => s.category === c.id)
        .map(renderCard)
        .join('')}
      </div>
    </section>`,
    )
    .join('');

  const bareSection = bare.length
    ? `
    <section class="cat" id="code-only" style="--cat:var(--muted)">
      <h2><span class="dot"></span>Repositories without a website</h2>
      ${chips(bare.map((b) => ({ label: b.repo.name, url: b.repo.html_url })))}
    </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="Every website and classroom app published from ${esc(config.ownerName)}'s GitHub repositories.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗂️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap">
<!-- Generated by scripts/build.mjs from data/sites.json. Edit those, not this file. -->
<style>
*{box-sizing:border-box}
:root{
  --bg:#f5f2ea;--surface:#fffdf7;--ink:#1d1b16;--muted:#6a6457;--line:#e2dccd;--chip:#eee9dc;--chip-hover:#e2dbc9;--focus:#1f5fbf;
  --new:#9a6f00;--courses:#2c6a9a;--activities:#b44a22;--tools:#3c7a4a;--personal:#7b55a6;
  --display:"Fraunces",Georgia,"Times New Roman",serif;
  --body:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#14130f;--surface:#1d1b16;--ink:#ede8dc;--muted:#a59f90;--line:#322f27;--chip:#29261f;--chip-hover:#37332a;--focus:#8ab8ff;
  --new:#d9aa3a;--courses:#72aad8;--activities:#e3845c;--tools:#7fbb8b;--personal:#b597dd;
}}
[hidden]{display:none!important}
html{scroll-padding-top:5rem}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--body);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(1rem,4vw,2.5rem)}
.hero{padding:clamp(3rem,8vw,5.5rem) 0 2.25rem}
.eyebrow{font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 1rem}
.eyebrow a{text-decoration:none;border-bottom:1px solid var(--line)}
.eyebrow a:hover{color:var(--ink);border-color:currentColor}
h1{font-family:var(--display);font-weight:600;font-size:clamp(2.5rem,6.5vw,4.4rem);line-height:1;letter-spacing:-.02em;margin:0 0 1.1rem;max-width:12ch}
.lede{font-size:1.15rem;color:var(--muted);max-width:58ch;margin:0}
.stats{display:flex;gap:2.25rem;flex-wrap:wrap;margin:2.25rem 0 0;padding:0;list-style:none;color:var(--muted);font-size:.9rem}
.stats b{display:block;font-family:var(--display);font-size:2.1rem;font-weight:600;line-height:1.05;color:var(--ink)}
.toolbar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 90%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.toolbar .wrap{display:flex;gap:.6rem 1rem;align-items:center;flex-wrap:wrap;padding-top:.7rem;padding-bottom:.7rem}
.search{flex:1 1 260px;position:relative;max-width:420px}
.search input{width:100%;font:inherit;font-size:.95rem;padding:.55rem 2.4rem .55rem 2.3rem;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink)}
.search input::placeholder{color:var(--muted)}
.search svg{position:absolute;left:.85rem;top:50%;transform:translateY(-50%);color:var(--muted)}
.search kbd{position:absolute;right:.75rem;top:50%;transform:translateY(-50%);font:.72rem var(--body);color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:.05rem .4rem}
@media (hover:none){.search kbd{display:none}}
.cats{display:flex;gap:.25rem;flex-wrap:wrap}
.cats a{text-decoration:none;font-size:.86rem;padding:.35rem .7rem;border-radius:999px;display:inline-flex;align-items:center;gap:.45rem;color:var(--muted);white-space:nowrap}
.cats a:hover{background:var(--chip);color:var(--ink)}
@media (max-width:640px){
  .toolbar .wrap{gap:.45rem}
  .search{max-width:none}
  .cats{flex:1 1 100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1*clamp(1rem,4vw,2.5rem));padding:0 clamp(1rem,4vw,2.5rem)}
  .cats::-webkit-scrollbar{display:none}
}
.dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--cat);display:inline-block;flex:none}
.cat{padding:3rem 0 .5rem}
.cat>h2{font-family:var(--display);font-weight:600;font-size:1.8rem;letter-spacing:-.01em;margin:0;display:flex;align-items:baseline;gap:.65rem}
.cat>h2 .dot{position:relative;top:-.12em}
.cat>p{color:var(--muted);margin:.35rem 0 1.4rem;max-width:65ch}
.cat>.chips{margin-top:1.2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,330px),1fr));gap:1rem}
.card{background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--cat);border-radius:12px;padding:1.15rem 1.25rem .9rem;display:flex;flex-direction:column;gap:.65rem;min-width:0}
.card h3{font-family:var(--display);font-weight:600;font-size:1.35rem;line-height:1.2;margin:0}
.card h3 a{text-decoration:none}
.card h3 a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.badge{font:700 .66rem/1 var(--body);letter-spacing:.08em;text-transform:uppercase;background:var(--new);color:var(--surface);padding:.25rem .45rem;border-radius:4px;vertical-align:.3em;margin-left:.3rem}
.url{margin:-.45rem 0 0;font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}
.summary{margin:0}
.chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.35rem}
.chips a{display:inline-block;text-decoration:none;font-size:.86rem;line-height:1.35;padding:.28rem .7rem;border-radius:999px;background:var(--chip)}
.chips a:hover{background:var(--chip-hover)}
.group-label,.group summary{margin:.15rem 0 .4rem;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.group summary{cursor:pointer;margin:0;padding:.2rem 0;width:max-content}
.group summary:hover{color:var(--ink)}
.count{font-weight:400;letter-spacing:0;margin-left:.15rem}
.list{margin:.35rem 0 .2rem;padding-left:1.6rem;font-size:.9rem}
.list li{margin:.2rem 0;padding-left:.15rem}
.list li::marker{color:var(--muted);font-size:.8em}
.list a{text-decoration:none}
.list a:hover{text-decoration:underline;text-underline-offset:3px}
.card footer{margin-top:auto;padding-top:.8rem;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:.3rem 1rem;flex-wrap:wrap;font-size:.8rem;color:var(--muted)}
.card footer a{text-decoration:none;display:inline-flex;align-items:center;gap:.4rem}
.card footer a:hover{color:var(--ink)}
.empty{padding:4rem 0;color:var(--muted);font-size:1.05rem}
.site-footer{margin-top:3.5rem;padding:2rem 0 3.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
.site-footer a{color:var(--ink)}
</style>
</head>
<body>
  <header class="hero wrap">
    <p class="eyebrow">${esc(config.ownerName)} · <a href="https://github.com/${esc(OWNER)}">github.com/${esc(OWNER)}</a></p>
    <h1>Sites &amp; classroom apps</h1>
    <p class="lede">Every website published from ${esc(config.ownerName)}'s GitHub repositories: course materials, interactive lecture demos, and teaching tools.</p>
    <ul class="stats">
      <li><b>${sites.length}</b>websites</li>
      <li><b>${pageCount}</b>pages</li>
      <li><b>${fmtDate(latest)}</b>latest update</li>
    </ul>
  </header>

  <div class="toolbar">
    <div class="wrap">
      <label class="search">${SEARCH_ICON}<input id="q" type="search" placeholder="Filter by name, topic, or page" aria-label="Filter sites" autocomplete="off"><kbd>/</kbd></label>
      <nav class="cats" aria-label="Categories">${filled
        .map((c) => `<a href="#${esc(c.id)}" style="--cat:${color(c.id)}"><span class="dot"></span>${esc(c.name)}</a>`)
        .join('')}</nav>
    </div>
  </div>

  <main class="wrap">${sections}${bareSection}
    <p class="empty" id="empty" hidden>No sites match that filter.</p>
  </main>

  <footer class="site-footer wrap">
    This page rebuilds itself from the GitHub API every six hours, so new sites and pages appear on their own.
    Source: <a href="https://github.com/${esc(OWNER)}/${esc(OWNER)}.github.io">${esc(OWNER)}/${esc(OWNER)}.github.io</a>.
  </footer>

<script>
(() => {
  const q = document.getElementById('q');
  const cards = [...document.querySelectorAll('.card')];
  const sections = [...document.querySelectorAll('main .cat')];
  const empty = document.getElementById('empty');
  q.addEventListener('input', () => {
    const t = q.value.trim().toLowerCase();
    cards.forEach((c) => { c.hidden = !!t && !c.dataset.search.includes(t); });
    sections.forEach((s) => { s.hidden = !!t && !s.querySelector('.card:not([hidden])'); });
    empty.hidden = cards.some((c) => !c.hidden);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); }
  });
})();
</script>
</body>
</html>
`;
}

// ---------- main ----------

const hide = new Set((config.hide || []).map((n) => n.toLowerCase()));
const repos = (await listRepos()).filter(
  (r) => !r.fork && !r.private && !r.archived && r.name.toLowerCase() !== `${OWNER}.github.io`.toLowerCase() && !hide.has(r.name.toLowerCase()),
);
const described = await mapLimit(repos, 4, describe);
const curatedOrder = Object.keys(config.repos);
const sites = described
  .filter((d) => d.kind === 'site')
  .sort((a, b) =>
    a.isNew || b.isNew ? Number(b.isNew) - Number(a.isNew) || b.updated.localeCompare(a.updated) : curatedOrder.indexOf(a.repoName) - curatedOrder.indexOf(b.repoName),
  );
const bare = described.filter((d) => d.kind === 'nosite');

await writeFile(path.join(ROOT, 'index.html'), renderPage(sites, bare));

const lines = [
  `Built index.html: ${sites.length} websites from ${repos.length} public repositories.`,
  ...report.newRepos.map((r) => `- New repo, not in data/sites.json yet: ${r}`),
  ...report.newPages.map((p) => `- New page, listed under "More pages": ${p}`),
  ...report.broken.map((u) => `- Curated link not responding: ${u}`),
  ...report.noSite.map((r) => `- No website: ${r}`),
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
