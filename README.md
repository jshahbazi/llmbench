# llmbench

LLM benchmark results from every listed leaderboard, side by side, at
[llmbench.site](https://llmbench.site). Every number keeps its source link, and you choose which
columns to compare.

The design and roadmap are in [docs/llm-benchmark-aggregator-plan.md](docs/llm-benchmark-aggregator-plan.md).
Phases 0 and 1 are built: five sources, change history, checks on every update, and a scheduled
GitHub workflow that commits new data and deploys the site.

## How it works

1. You list sources in [`sources.yaml`](sources.yaml).
2. The **update** workflow runs every 6 hours. It fetches each source that is due, checks the result,
   records what changed, and commits it to `data/`.
3. The same run builds the site from `data/` and deploys it to GitHub Pages.
4. If a source breaks, its last good data stays published and an issue titled
   `Source problem: <id>` is opened. It closes itself when the source recovers.

## Adding a source

Most sources need no code. For a CSV, JSON, YAML or Parquet file, add an entry to `sources.yaml`:

```yaml
  - id: my-board
    name: My Leaderboard
    homepage: https://example.org/leaderboard
    fetch: https://example.org/leaderboard.csv     # or github:owner/repo/path, or hf:owner/dataset
    model: Model                                   # the column with the model name
    license: MIT
    terms: allowed                                 # only after you have read the site's terms
```

Every numeric column becomes a score unless you list `scores`. Long tables (one row per model and
metric) use `metric` and `value`. The comment at the top of `sources.yaml` lists every option, and
the plan's section 3 explains them. Sources that need custom logic get a plugin in
`scripts/sources/` (see `epoch.ts`).

Check a new entry locally before committing:

```sh
npm run validate
npm run scrape -- --source my-board
```

## Run it locally

Needs Node 24 or later (it runs the TypeScript directly) and Python 3 for the preview server.

```sh
npm install
npm run scrape    # fetch due sources into data/ (--force to ignore "not due" and "unchanged")
npm run resolve   # match model names to the catalogue
npm run build     # build site/dist from data/
npm run preview   # serve site/dist at http://localhost:4321
```

`npm test` runs the tests and `npm run typecheck` type-checks.

## When a source is held

A run is held when its new data fails a check: missing columns, far fewer rows than before, more than
20% of existing scores changing at once, a numeric column turning into text, or repeated rows. Fix
the entry in `sources.yaml` and the next run re-checks it. If the change is real, run the **update**
workflow from the Actions tab with `accept` set to the source id.

## Where things live

| Path | What | Edited by |
| :-- | :-- | :-- |
| `sources.yaml` | What to pull from | you |
| `curation/aliases.csv` | Optional `source,raw_name,model_id` lines to fix model matching | you |
| `data/sources/<id>/` | Rows exactly as published, metrics, state, change history | the workflow |
| `data/catalog/models.jsonl` | Canonical models, seeded from whatmodel.sh | the workflow |
| `data/resolved/aliases.csv` | How every model name was matched | the workflow |
| `data/reports/unmatched.csv` | Model names with no match, most-used first | the workflow |
| `scripts/` | Scraper, matching, build, source plugins | code |
| `site/static/` | The page | code |

## Licence

Code: MIT (`LICENSE`). Data: CC BY-SA 4.0, with every source's own licence and attribution kept; see
`DATA-LICENSE.md`.
