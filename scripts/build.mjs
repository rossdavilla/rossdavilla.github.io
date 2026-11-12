#!/usr/bin/env node
// Rebuilds index.html: a directory of every web app published from the owner's public
// GitHub repositories, one card per app with a screenshot and class tags. Apps, tags and
// summaries come from data/sites.json; anything that file doesn't mention (a new repo, a
// new page in a known repo) is discovered through the GitHub API and shown under "Just added".
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs                 # shoot new/changed apps
//   GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs --reshoot all   # or --reshoot id1,id2
//   SKIP_SHOTS=1 node scripts/build.mjs                                  # no screenshots

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateThumbs } from './shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'data', 'sites.json'), 'utf8'));
const OWNER = config.owner;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const report = { newRepos: [], newPages: [], broken: [], noSite: [], missingRepo: [], shots: [] };

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

// Where a repo's site lives and which pages it publishes.
async function siteInfo(repo) {
  const cur = config.repos?.[repo.name];
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
      // The Actions token can't read other repos' Pages settings; guess the source.
      try {
        await api(`repos/${OWNER}/${repo.name}/branches/gh-pages`);
        branch = 'gh-pages';
      } catch {}
    }
    try {
      const tree = await api(`repos/${OWNER}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const all = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
      if (!siteRoot && !all.some((f) => /^index\.html?$/i.test(f)) && all.some((f) => /^docs\/index\.html?$/i.test(f))) siteRoot = 'docs/';
      files = all.filter((f) => f.startsWith(siteRoot)).map((f) => f.slice(siteRoot.length));
    } catch {}
  } else if (repo.homepage) {
    base = repo.homepage.replace(/\/?$/, '/');
  }

  const ignore = [...(config.ignore || []), ...(cur?.ignore || [])].map(globToRegExp);
  const pages = files.filter((f) => /\.html?$/i.test(f) && !ignore.some((re) => re.test(f)));
  const strip = [...(config.stripTitle || []), ...(cur?.stripTitle || [])];
  const titleOf = async (p) => stripTitle(await fetchTitle(repo.name, branch, siteRoot + normalize(p)), strip);
  return { repo, base, pages, titleOf };
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// ---------- rendering ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const SEARCH_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8.5 15a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm4.8-1.7L18 18"/></svg>';

const NEW_TAG = { id: 'new', label: 'New', name: 'Just added', blurb: 'Found on GitHub since this directory was last curated.' };
const tagList = [NEW_TAG, ...config.tags];
const tagById = Object.fromEntries(tagList.map((t) => [t.id, t]));

const initials = (name) =>
  name
    .split(/\s+/)
    .filter((w) => /^[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

function renderCard(c, hasThumb) {
  const search = [c.name, c.summary, c.repoName, ...c.tags.map((t) => `${tagById[t]?.label} ${tagById[t]?.name}`), ...c.links.map((l) => l.label)].join(' ').toLowerCase();
  const shot = hasThumb
    ? `<img src="thumbs/${esc(c.id)}.webp?v=${esc(c.thumbVersion)}" alt="" loading="lazy" decoding="async" width="600" height="450">`
    : `<span class="ph" aria-hidden="true">${esc(initials(c.name))}</span>`;
  const more = c.links.length
    ? `<details class="more"><summary>${c.links.length === 1 ? '1 more link' : `${c.links.length} more links`}</summary><ul>${c.links
        .map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`)
        .join('')}</ul></details>`
    : '<span></span>';
  return `
        <article class="card" data-search="${esc(search)}">
          <h3><a href="${esc(c.url)}">${esc(c.name)}</a></h3>
          <div class="shot">${shot}<ul class="tags">${c.tags.map((t) => `<li class="tag t-${esc(t)}">${esc(tagById[t]?.label ?? t)}</li>`).join('')}</ul></div>
          <p class="summary">${esc(c.summary)}</p>
          <div class="foot">${more}<a class="gh" href="${esc(c.repoUrl)}" title="Source: ${esc(`${OWNER}/${c.repoName}`)}" aria-label="Source on GitHub: ${esc(`${OWNER}/${c.repoName}`)}">${GITHUB_ICON}</a></div>
        </article>`;
}

function renderPage(cards, thumbs, bare) {
  const filled = tagList.filter((t) => cards.some((c) => c.tags.includes(t.id)));
  const appCount = cards.length;
  const classCount = cards.filter((c) => c.tags.some((t) => /^PSY/.test(t))).length;
  const latest = cards.map((c) => c.updated).sort().at(-1);
  const title = `${config.ownerName} · Classroom Apps`;

  const sections = filled
    .map(
      (t) => `
    <section class="cat" id="${esc(t.id)}" data-tag="${esc(t.id)}">
      <div class="cat-head"><h2><span class="tag t-${esc(t.id)}">${esc(t.label)}</span>${t.label !== t.name ? ` ${esc(t.name)}` : ''}</h2>${t.blurb ? `<p>${esc(t.blurb)}</p>` : ''}</div>
      <div class="grid">${cards
        .filter((c) => c.tags.includes(t.id))
        .map((c) => renderCard(c, thumbs.has(c.id)))
        .join('')}
      </div>
    </section>`,
    )
    .join('');

  const bareSection = bare.length
    ? `
    <section class="cat" id="code-only" data-tag="code-only">
      <div class="cat-head"><h2>Repositories without a website</h2></div>
      <ul class="plain">${bare.map((r) => `<li><a href="${esc(r.html_url)}">${esc(r.name)}</a></li>`).join('')}</ul>
    </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#1D3557">
<title>${esc(title)}</title>
<meta name="description" content="Every classroom app and website published from ${esc(config.ownerName)}'s GitHub repositories, tagged by class.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2222%22 fill=%22%231D3557%22/><rect x=%2220%22 y=%2216%22 width=%2226%22 height=%2234%22 rx=%225%22 fill=%22%23E63946%22/><rect x=%2254%22 y=%2216%22 width=%2226%22 height=%2234%22 rx=%225%22 fill=%22%23A8DADC%22/><rect x=%2220%22 y=%2256%22 width=%2226%22 height=%2234%22 rx=%225%22 fill=%22%23F1FAEE%22/><rect x=%2254%22 y=%2256%22 width=%2226%22 height=%2234%22 rx=%225%22 fill=%22%23457B9D%22/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap">
<!-- Generated by scripts/build.mjs from data/sites.json. Edit those, not this file. -->
<style>
*{box-sizing:border-box}
:root{
  --red:#E63946;--mint:#F1FAEE;--teal:#A8DADC;--steel:#457B9D;--navy:#1D3557;--ink:#000;
  --surface:#fff;--line:#cfe3e4;--soft:#2b3f5c;
  --display:"Fraunces",Georgia,"Times New Roman",serif;
  --body:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
[hidden]{display:none!important}
html{scroll-padding-top:5.5rem}
body{margin:0;background:var(--mint);color:var(--ink);font:16px/1.5 var(--body);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:3px solid var(--red);outline-offset:2px;border-radius:6px}
.wrap{max-width:1240px;margin:0 auto;padding:0 clamp(1rem,4vw,2.5rem)}

.hero{background:var(--navy);color:var(--mint);position:relative;overflow:hidden}
.hero::after{content:"";position:absolute;inset:auto 0 0 0;height:6px;background:linear-gradient(90deg,var(--red) 0 25%,var(--mint) 25% 50%,var(--teal) 50% 75%,var(--steel) 75%)}
.hero .wrap{padding-top:clamp(2.5rem,7vw,4.5rem);padding-bottom:clamp(2.25rem,5vw,3.25rem)}
.eyebrow{font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--teal);margin:0 0 .9rem}
.eyebrow a{text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--teal) 50%,transparent)}
.eyebrow a:hover{border-color:currentColor}
h1{font-family:var(--display);font-weight:700;font-size:clamp(2.4rem,6vw,4.2rem);line-height:1;letter-spacing:-.02em;margin:0 0 1rem}
h1 em{font-style:normal;color:var(--red)}
.lede{font-size:1.1rem;color:var(--mint);opacity:.9;max-width:60ch;margin:0}
.stats{display:flex;gap:1rem 2.25rem;flex-wrap:wrap;margin:2rem 0 0;padding:0;list-style:none;color:var(--teal);font-size:.88rem}
.stats b{display:block;font-family:var(--display);font-size:clamp(1.5rem,5vw,2rem);font-weight:600;line-height:1.05;color:var(--mint)}

.toolbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--mint) 92%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.toolbar .wrap{display:flex;gap:.6rem 1rem;align-items:center;flex-wrap:wrap;padding-top:.7rem;padding-bottom:.7rem}
.search{flex:0 1 300px;position:relative}
.search input{width:100%;font:inherit;font-size:.95rem;padding:.5rem 2.2rem .5rem 2.3rem;border:1.5px solid var(--steel);border-radius:999px;background:var(--surface);color:var(--ink)}
.search input::placeholder{color:var(--soft)}
.search svg{position:absolute;left:.85rem;top:50%;transform:translateY(-50%);color:var(--navy)}
.search kbd{position:absolute;right:.8rem;top:50%;transform:translateY(-50%);font:.72rem var(--body);color:var(--soft);border:1px solid var(--line);border-radius:4px;padding:.05rem .4rem}
@media (hover:none){.search kbd{display:none}}
.filters{display:flex;gap:.35rem;flex-wrap:wrap;flex:1 1 400px}
.filters button{font:inherit;font-size:.84rem;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:.4rem;padding:.32rem .75rem;border-radius:999px;border:1.5px solid var(--navy);background:var(--surface);color:var(--ink);white-space:nowrap}
.filters button:hover{background:var(--teal)}
.filters button[aria-pressed="true"]{background:var(--navy);color:var(--mint)}
.filters .n{font-size:.75rem;opacity:.7}
.filters .sw{width:.65rem;height:.65rem;border-radius:50%;border:1px solid rgba(0,0,0,.35)}
@media (max-width:700px){
  .search{flex:1 1 100%}
  .filters{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1*clamp(1rem,4vw,2.5rem));padding:0 clamp(1rem,4vw,2.5rem) .1rem}
  .filters::-webkit-scrollbar{display:none}
}

.tag{display:inline-block;font:600 .7rem/1 var(--body);letter-spacing:.03em;padding:.3rem .5rem;border-radius:999px;background:var(--surface);color:var(--ink);border:1px solid var(--navy);white-space:nowrap}
.t-PSY001{background:var(--red);border-color:var(--red);color:var(--ink)}
.t-PSY157{background:var(--teal);border-color:var(--teal);color:var(--ink)}
.t-PSY170{background:var(--steel);border-color:var(--steel);color:#fff}
.t-PSY175{background:var(--navy);border-color:var(--navy);color:#fff}
.t-textbook{background:var(--mint);border-color:var(--navy);color:var(--ink)}
.t-new{background:var(--ink);border-color:var(--ink);color:#fff}

.cat{padding:2.75rem 0 .5rem}
.cat-head{margin:0 0 1.25rem}
.cat-head h2{font-family:var(--display);font-weight:600;font-size:1.7rem;letter-spacing:-.01em;margin:0;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.cat-head h2 .tag{font-size:.95rem;padding:.4rem .7rem;font-family:var(--body)}
.cat-head p{color:var(--soft);margin:.4rem 0 0;max-width:68ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,232px),1fr));gap:1.25rem}

.card{position:relative;aspect-ratio:3/4;display:flex;flex-direction:column;gap:.6rem;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:.9rem .9rem .7rem;box-shadow:0 1px 2px rgba(29,53,87,.06),0 4px 14px rgba(29,53,87,.06);transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}
.card:hover{transform:translateY(-3px);border-color:var(--steel);box-shadow:0 2px 4px rgba(29,53,87,.08),0 12px 28px rgba(29,53,87,.14)}
.card:focus-within{border-color:var(--steel)}
.card h3{margin:0;height:2.5em;display:flex;align-items:flex-end;font:600 1.08rem/1.25 var(--display);letter-spacing:-.005em;flex:none}
.card h3 a{text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card h3 a::after{content:"";position:absolute;inset:0;z-index:1;border-radius:16px}
.shot{position:relative;flex:1 1 auto;min-height:0;border-radius:10px;overflow:hidden;background:var(--teal);border:1px solid var(--line)}
.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
.ph{position:absolute;inset:0;display:grid;place-items:center;font:700 2.6rem/1 var(--display);color:var(--navy);background:linear-gradient(135deg,var(--teal),var(--mint))}
.shot .tags{position:absolute;left:.45rem;bottom:.45rem;right:.45rem;display:flex;flex-wrap:wrap;gap:.25rem;margin:0;padding:0;list-style:none}
.shot .tag{box-shadow:0 1px 3px rgba(0,0,0,.25)}
.summary{margin:0;font-size:.84rem;line-height:1.4;height:4.2em;flex:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:1.6rem;font-size:.78rem;color:var(--soft);position:relative;z-index:2}
.foot .gh{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;color:var(--soft)}
.foot .gh:hover{background:var(--mint);color:var(--ink)}
.more{position:relative}
.more summary{cursor:pointer;list-style:none;padding:.15rem .55rem;border-radius:999px;border:1px solid var(--line);font-weight:500;color:var(--navy)}
.more summary::-webkit-details-marker{display:none}
.more summary::after{content:" ▾";font-size:.8em}
.more[open] summary::after{content:" ▴"}
.more summary:hover{background:var(--mint)}
.more ul{position:absolute;left:0;bottom:calc(100% + .4rem);z-index:5;width:max-content;max-width:min(17rem,80vw);margin:0;padding:.4rem;list-style:none;background:var(--surface);border:1px solid var(--steel);border-radius:10px;box-shadow:0 10px 30px rgba(29,53,87,.22)}
.more li a{display:block;padding:.4rem .55rem;border-radius:6px;text-decoration:none;font-size:.84rem;color:var(--ink);line-height:1.3}
.more li a:hover{background:var(--teal)}
.card:has(.more[open]){z-index:6}

.plain{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;margin:0;padding:0}
.plain a{display:inline-block;text-decoration:none;font-size:.86rem;padding:.28rem .7rem;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
.plain a:hover{background:var(--teal)}
.empty{padding:4rem 0;color:var(--soft);font-size:1.05rem}
.site-footer{margin-top:3.5rem;padding:2rem 0 3.5rem;border-top:1px solid var(--line);color:var(--soft);font-size:.85rem}
.site-footer a{color:var(--ink)}
@media (prefers-reduced-motion:reduce){.card{transition:none}.card:hover{transform:none}}
</style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <p class="eyebrow">${esc(config.ownerName)} · <a href="https://github.com/${esc(OWNER)}">github.com/${esc(OWNER)}</a></p>
      <h1>Classroom apps<em>.</em></h1>
      <p class="lede">Interactive demos, self-scoring scales, and games for ${esc(config.ownerName)}'s psychology classes, plus the open Human Sexuality textbook and a few teaching tools. Filter by class or search to find one.</p>
      <ul class="stats">
        <li><b>${appCount}</b>apps &amp; sites</li>
        <li><b>${classCount}</b>for classes</li>
        <li><b>${fmtDate(latest)}</b>latest update</li>
      </ul>
    </div>
  </header>

  <div class="toolbar">
    <div class="wrap">
      <label class="search">${SEARCH_ICON}<input id="q" type="search" placeholder="Search apps" aria-label="Search apps" autocomplete="off"><kbd>/</kbd></label>
      <div class="filters" role="group" aria-label="Filter by class">
        <button type="button" data-filter="" aria-pressed="true">All <span class="n">${appCount}</span></button>${filled
          .map(
            (t) =>
              `<button type="button" data-filter="${esc(t.id)}" aria-pressed="false"><span class="sw t-${esc(t.id)}"></span>${esc(t.label)}${t.short ? ` · ${esc(t.short)}` : ''} <span class="n">${cards.filter((c) => c.tags.includes(t.id)).length}</span></button>`,
          )
          .join('')}
      </div>
    </div>
  </div>

  <main class="wrap">${sections}${bareSection}
    <p class="empty" id="empty" hidden>No apps match that search.</p>
  </main>

  <footer class="site-footer wrap">
    This page rebuilds itself from the GitHub API every six hours, so new apps appear on their own, with fresh screenshots whenever an app changes.
    Source: <a href="https://github.com/${esc(OWNER)}/${esc(OWNER)}.github.io">${esc(OWNER)}/${esc(OWNER)}.github.io</a>.
  </footer>

<script>
(() => {
  const q = document.getElementById('q');
  const sections = [...document.querySelectorAll('main .cat')];
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const empty = document.getElementById('empty');
  let tag = '';
  const apply = () => {
    const t = q.value.trim().toLowerCase();
    let any = false;
    sections.forEach((s) => {
      const inTag = !tag || s.dataset.tag === tag;
      let shown = 0;
      s.querySelectorAll('.card').forEach((c) => {
        const ok = inTag && (!t || c.dataset.search.includes(t));
        c.hidden = !ok;
        if (ok) shown++;
      });
      s.hidden = !inTag || (!!t && !shown);
      if (shown) any = true;
    });
    empty.hidden = any;
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === tag)));
  };
  const setTag = (id, push) => {
    tag = buttons.some((b) => b.dataset.filter === id) ? id : '';
    if (push) history.replaceState(null, '', tag ? '#' + tag : location.pathname + location.search);
    apply();
  };
  buttons.forEach((b) => b.addEventListener('click', () => { setTag(b.dataset.filter, true); window.scrollTo({ top: document.querySelector('.toolbar').offsetTop, behavior: 'smooth' }); }));
  q.addEventListener('input', apply);
  addEventListener('hashchange', () => setTag(decodeURIComponent(location.hash.slice(1)), false));
  setTag(decodeURIComponent(location.hash.slice(1)), false);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; apply(); q.blur(); }
  });
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
})();
</script>
</body>
</html>
`;
}

// ---------- main ----------

const args = process.argv.slice(2);
const reshootArg = args.includes('--reshoot') ? args[args.indexOf('--reshoot') + 1] || 'all' : null;
const reshoot = reshootArg === 'all' ? true : reshootArg ? reshootArg.split(',') : false;

const hide = new Set((config.hide || []).map((n) => n.toLowerCase()));
const repos = (await listRepos()).filter(
  (r) => !r.fork && !r.private && !r.archived && r.name.toLowerCase() !== `${OWNER}.github.io`.toLowerCase() && !hide.has(r.name.toLowerCase()),
);
const infos = Object.fromEntries((await mapLimit(repos, 4, siteInfo)).map((i) => [i.repo.name, i]));

// Curated apps.
const covered = {}; // repo name -> [RegExp] of pages already shown somewhere
const cover = (repo, re) => (covered[repo] ||= []).push(re);
const exact = (p) => new RegExp(`^${normalize(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const curated = (
  await mapLimit(config.apps, 6, async (app) => {
    const info = infos[app.repo];
    if (!info?.base) {
      report.missingRepo.push(`${app.id} (${app.repo})`);
      return null;
    }
    const url = app.url || pageUrl(info.base, app.path ?? '');
    cover(app.repo, exact(app.path ?? ''));
    (app.covers || []).forEach((g) => cover(app.repo, globToRegExp(g)));
    const links = await mapLimit(app.links || [], 6, async (l) => {
      const li = infos[l.repo || app.repo];
      if (!li?.base) return null;
      cover(li.repo.name, exact(l.path));
      const lurl = l.url || pageUrl(li.base, l.path);
      if (!(await isLive(lurl))) report.broken.push(lurl);
      return { label: l.label || (await li.titleOf(l.path)) || fallbackLabel(l.path), url: lurl };
    });
    if (!(await isLive(url))) report.broken.push(url);
    return {
      id: app.id,
      name: app.name,
      summary: app.summary || info.repo.description || '',
      tags: app.tags?.length ? app.tags : ['new'],
      url,
      links: links.filter(Boolean),
      repoName: info.repo.name,
      repoUrl: info.repo.html_url,
      updated: info.repo.pushed_at,
      shot: app.shot,
    };
  })
).filter(Boolean);

// Anything published that no app mentions.
const curatedRepos = new Set(config.apps.map((a) => a.repo));
const discovered = [];
for (const info of Object.values(infos)) {
  const { repo, base, pages, titleOf } = info;
  if (!base) {
    report.noSite.push(repo.name);
    continue;
  }
  const isCovered = (p) => (covered[repo.name] || []).some((re) => re.test(normalize(p)));
  const loose = pages.filter((p) => !isCovered(p));
  const make = async (p, links = []) => {
    const url = pageUrl(base, p);
    if (!(await isLive(url))) return null;
    const name = (await titleOf(p)) || fallbackLabel(p) || repo.name.replace(/[-_]+/g, ' ');
    return {
      id: slug(`${repo.name}-${normalize(p).replace(/(^|\/)index\.html$/i, '')}`) || slug(repo.name),
      name,
      summary: curatedRepos.has(repo.name) ? `A new page in ${repo.name}.` : repo.description || '',
      tags: ['new'],
      url,
      links,
      repoName: repo.name,
      repoUrl: repo.html_url,
      updated: repo.pushed_at,
    };
  };
  if (!curatedRepos.has(repo.name)) {
    const primary = loose.find((p) => /^index\.html?$/i.test(p)) ?? loose[0] ?? '';
    const links = (
      await mapLimit(
        loose.filter((p) => p !== primary),
        6,
        async (p) => ((await isLive(pageUrl(base, p))) ? { label: (await titleOf(p)) || fallbackLabel(p), url: pageUrl(base, p) } : null),
      )
    ).filter(Boolean);
    const card = await make(primary, links);
    if (card) {
      discovered.push(card);
      report.newRepos.push(repo.name);
    }
  } else {
    for (const p of loose) {
      const card = await make(p);
      if (card) {
        discovered.push(card);
        report.newPages.push(`${repo.name}/${p}`);
      }
    }
  }
}

discovered.sort((a, b) => b.updated.localeCompare(a.updated));
const cards = [...discovered, ...curated];
const thumbs = await updateThumbs(ROOT, cards, { force: reshoot, log: (l) => report.shots.push(l) });
const manifest = JSON.parse(await readFile(path.join(ROOT, 'data', 'thumbs.json'), 'utf8'));
cards.forEach((c) => (c.thumbVersion = (manifest[c.id]?.taken || '').replace(/\D/g, '').slice(0, 12)));
const bare = report.noSite.map((n) => infos[n].repo);

await writeFile(path.join(ROOT, 'index.html'), renderPage(cards, thumbs, bare));

const lines = [
  `Built index.html: ${cards.length} cards (${thumbs.size} with screenshots) from ${repos.length} public repositories.`,
  ...report.newRepos.map((r) => `- New repo, not in data/sites.json yet: ${r}`),
  ...report.newPages.map((p) => `- New page, listed under "Just added": ${p}`),
  ...report.missingRepo.map((a) => `- App's repo has no site or isn't public: ${a}`),
  ...report.broken.map((u) => `- Link not responding: ${u}`),
  ...report.noSite.map((r) => `- No website: ${r}`),
  ...report.shots,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
