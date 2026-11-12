# rossdavilla.github.io

A directory of every web app published from my GitHub repositories, one card per app with a
screenshot, tagged by the class it's for.

**Live:** https://rossdavilla.github.io/

## How it stays up to date

`.github/workflows/rebuild.yml` runs every six hours, on every push to `main`, and whenever you click
**Run workflow** on the Actions tab. It:

1. Lists every public, non-fork repository on the account through the GitHub API.
2. Finds each repo's website (its GitHub Pages site, or the repo's website field) and every HTML page in it.
3. Screenshots any app that is new, whose URL changed, or whose repo has been pushed since its last
   screenshot (headless Chrome, saved to `thumbs/<id>.webp`, logged in `data/thumbs.json`).
4. Regenerates `index.html`, commits it and the screenshots if anything changed, and deploys to GitHub Pages.

New apps show up on their own under **Just added**: a new repo gets one card, and a new page in a
known repo gets its own card.

## Curating

`data/sites.json` holds the hand-written layer:

| Field | What it does |
| --- | --- |
| `tags` | The class tags (PSY001, PSY157, PSY170, PSY175, Textbook, Teaching tools, Personal), in page order. `short` is the filter-button label |
| `apps[]` | One card each: `id` (also the screenshot's filename), `repo`, `name`, one-sentence `summary`, `path` (the page the card opens), and `tags` |
| `apps[].links` | Extra versions shown under "more links": `{ label, path }`, plus `repo` when the page lives in another repo |
| `apps[].covers` | Globs for pages the card stands for without listing them (e.g. textbook chapters) |
| `apps[].shot` | Screenshot options: `width`/`height` of the viewport (default 800×600; 720×540 suits Top Hat embeds), `delay` in ms, or `none: true` for a placeholder |
| `repos.<name>.ignore` | Glob patterns for pages that shouldn't be listed (mockups, templates, drafts) |
| `repos.<name>.stripTitle` | Regexes removed from automatic `<title>` labels |
| `ignore` / `hide` | Glob patterns ignored in every repo / repos left off entirely |

An app can carry several tags and then appears under each class. Push a change to `data/sites.json`
and the site rebuilds.

## Building locally

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs
```

Add `--reshoot all` (or `--reshoot id1,id2`) to retake screenshots, or set `SKIP_SHOTS=1` to skip
them. `index.html` is generated, so don't edit it by hand.
