# llmbench

LLM benchmark results from every listed leaderboard, side by side, at
[llmbench.site](https://llmbench.site). Every number keeps its source link, and you choose which
columns to compare.

The design and roadmap are in [docs/llm-benchmark-aggregator-plan.md](docs/llm-benchmark-aggregator-plan.md).
Phases 0–3 are built and Phase 4 is under way: 29 sources, change history, checks on every update,
a scheduled GitHub workflow that commits new data and deploys the site, the explorer with a chart
mode, a page for every model, benchmark and source, model-name matching you can correct in one line,
downloads, an in-browser SQL console, and a command that drafts a new source's entry.

## The site

- **Explorer** (home): pick any columns from any source, or start from a preset such as Coding or
  Math. Filter by release date, size, maker, licence and who ran the evaluation. Sort by any column,
  click a score to see every score behind it and where each came from, and compare up to five models
  side by side, or switch to a chart of any column against release date, size or another column. The
  whole view is in the URL, so "Copy link" shares exactly what you see, and "Download CSV" exports it.
- **Model pages** (`/models/<id>/`): every score for one model, with its rank in each column.
- **Benchmark pages** (`/benchmarks/<source>/<metric>/`): the full leaderboard for one column.
- **Source pages** (`/sources/<id>/`): status, licence, metrics, how each model name was matched, and
  recent changes.
- **Downloads** (`/data/`): every score as CSV, Parquet and SQLite, with models, benchmarks, names and
  sources.

## How it works

1. You list sources in [`sources.yaml`](sources.yaml).
2. The **update** workflow runs every 6 hours. It fetches each source that is due, checks the result,
   records what changed, and commits it to `data/`.
3. The same run builds the site from `data/` and deploys it to GitHub Pages.
4. If a source breaks, its last good data stays published and an issue titled
   `Source problem: <id>` is opened. It closes itself when the source recovers.

## Adding a source

Most sources need no code. For a CSV, JSON, YAML, Parquet file or a Markdown table (such as a
leaderboard in a README), let the tool draft the entry:

```sh
npm run add-source -- https://example.org/leaderboard.csv
npm run add-source -- github:owner/repo/README.md --table 0
```

It reads the file, lists its columns, and prints an entry to check and paste into `sources.yaml`,
with `terms: blocked` until you have read the source's terms. A source is blocked only when its
terms forbid reuse or automated access; a missing or non-commercial licence is not a reason, and is
labelled on the site and in every download instead. A finished entry looks like this:

```yaml
  - id: my-board
    name: My Leaderboard
    homepage: https://example.org/leaderboard
    fetch: https://example.org/leaderboard.csv     # or github:owner/repo/path, or hf:owner/dataset
    model: Model                                   # the column with the model name
    license: MIT                                   # as the source states it, or "none stated"
    terms: allowed                                 # only after you have read the site's terms
```

Every numeric column becomes a score unless you list `scores`. Long tables (one row per model and
metric) use `metric` and `value`. The comment at the top of `sources.yaml` lists every option, and
the plan's section 3 explains them. Sources that need custom logic get a plugin in
`scripts/sources/` (see `epoch.ts`).

Check a new entry locally before committing:

```sh
npm run validate
npm run scrape -- --source my-board --dry-run   # shows what would be recorded, writes nothing
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

## Fixing a model match

Sources name models differently ("o1-2024-12-17_high", "o1 (high)"). The matcher sets aside
qualifiers such as reasoning effort, snapshot date or "(FC)", and matches only when exactly one
catalogue model fits; the method page on the site explains the rules. Each source's page lists every
name, the model it went to and how, and `data/reports/unmatched.csv` lists names with no catalogue
model, with near misses.

To fix one, add a line to [`curation/aliases.csv`](curation/aliases.csv):

```csv
source,raw_name,model_id,note
arena,Command R,command-r-03-2024,Arena lists the 08-2024 release separately
*,mistral-large-2411,mistral-large-2,
epoch,Some Name,-,keep this name apart
```

`*` applies to every source, and `-` keeps a name from being matched. To add a model the catalogue
lacks, or correct one, edit [`curation/models.yaml`](curation/models.yaml). Then:

```sh
npm run validate   # checks both files
npm run resolve    # shows the new match counts
```

Pushing to `main` rebuilds the site.

## When a source is held

A run is held when its new data fails a check: missing columns, far fewer rows than before, more than
20% of existing scores changing at once, a numeric column turning into text, or repeated rows. Fix
the entry in `sources.yaml` and the next run re-checks it. If the change is real, run the **update**
workflow from the Actions tab with `accept` set to the source id.

## Where things live

| Path | What | Edited by |
| :-- | :-- | :-- |
| `sources.yaml` | What to pull from | you |
| `curation/aliases.csv` | `source,raw_name,model_id` lines that fix model matching (`*` for any source, `-` to keep a name unmatched) | you |
| `curation/models.yaml` | Models to add to the catalogue, or fields to correct | you |
| `data/sources/<id>/` | Rows exactly as published, metrics, state, change history | the workflow |
| `data/catalog/models.jsonl` | Canonical models, seeded from whatmodel.sh | the workflow |
| `data/resolved/aliases.csv` | How every model name was matched, and the qualifiers set aside | the workflow |
| `data/resolved/unlisted.csv` | Models not in the catalogue, each gathering the names that agree | the workflow |
| `data/reports/unmatched.csv` | Names not in the catalogue, most-used first, with near misses | the workflow |
| `scripts/` | Scraper, matching, source plugins | code |
| `scripts/build.ts`, `scripts/site/` | Builds every page and data file into `site/dist` | code |
| `site/src/` | The explorer (TypeScript, turned into browser modules at build time) | code |
| `site/static/` | Stylesheet | code |

## Licence

Code: MIT (`LICENSE`). Data: the compilation is CC BY-SA 4.0, and every source's scores keep that
source's own licence and attribution. Some sources are non-commercial (CC BY-NC) and some state no
licence; both are labelled, and every download row carries its source's licence. See
`DATA-LICENSE.md`.
