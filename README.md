# rossdavilla.github.io

A directory of every website published from my GitHub repositories.

**Live:** https://rossdavilla.github.io/

## How it stays up to date

`.github/workflows/rebuild.yml` runs every six hours, on every push to `main`, and whenever you click
**Run workflow** on the Actions tab. It:

1. Lists every public, non-fork repository on the account through the GitHub API.
2. Finds each repo's website (its GitHub Pages site, or the repo's website field) and every HTML page in it.
3. Regenerates `index.html`, commits it if anything changed, and deploys it to GitHub Pages.

New sites show up on their own. A new repo appears under **Just added**, and a new page in a known
repo appears under that site's **More pages**.

## Curating

`data/sites.json` holds the hand-written layer:

| Field | What it does |
| --- | --- |
| `categories` | The sections of the page, in order |
| `repos.<name>.category` / `name` / `summary` | Where a site is filed and how it's described |
| `repos.<name>.primary` | The page the site's title links to (default: the repo's root) |
| `repos.<name>.links` | Pages to list as `{ label, path, group }`. Leave out `label` to use the page's `<title>`, and use `group` to collect links under a heading |
| `repos.<name>.ignore` | Glob patterns for pages that shouldn't be listed (mockups, templates, drafts) |
| `repos.<name>.stripTitle` | Regexes removed from automatic `<title>` labels |
| `ignore` / `hide` | Glob patterns ignored in every repo / repos left off entirely |

Push a change to `data/sites.json` and the site rebuilds.

## Building locally

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs
```

`index.html` is generated, so don't edit it by hand.
