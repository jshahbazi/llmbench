# LLM Benchmark Aggregator — Plan (v3, GitHub-native)

> Revised 2026-11-12. Replaces the Cloudflare design. Source layouts, licences and GitHub limits quoted
> here were checked against the live source on that date.

## 1. Summary

A public site that pulls in any benchmark, leaderboard or results page you list, shows every one of
them, and lets a visitor sort, filter and compare across all of them. Everything lives in one public
GitHub repository:

- **You edit one flat file, `sources.yaml`**, to say what to pull from.
- **A scheduled GitHub Actions run** fetches each source, records what changed, and commits the result
  to `data/` as plain text.
- **The same run builds a static site** from `data/` and deploys it to GitHub Pages.

There is no server, no database and no admin UI. Git history is the audit trail, Issues are the alert
inbox, and pull requests are how anything gets corrected. Running cost is $0 beyond the domain:
standard Actions runners and Pages are free for public repositories, and `jshahbazi/llmbench` is
public. The site is served at **llmbench.site** (registered at Cloudflare; DNS-only A, AAAA and
`www` CNAME records point at GitHub Pages, which issues the HTTPS certificate).

**Status (2026-11-13):** Phases 0 to 3 are built and Phase 4 is under way — seven sources,
field-mapping extractor, change history, guards, issue reporting, the update workflow, the explorer
with a chart mode, a page for every model, benchmark column and source, name matching with curation
files, CSV, Parquet and SQLite downloads, and `npm run add-source`. Section 12 lists what was learned
in each.

### 1.1 Goals

- **Accept anything.** A new source is a few lines in `sources.yaml`. Structured files need no code.
- **Show everything.** A source is visible in full the moment it is ingested, with no curation step in
  the way. Cross-source merging is layered on top and never hides data.
- **Let the visitor decide.** Any metric from any source can be a column. Sort and filter by anything.
  There is no built-in overall score.
- **Every number is traceable** to its source page, stored verbatim, with its change history.
- **A broken source never corrupts published data.** It is held and an issue is opened.

### 1.2 Non-goals

- No composite score. [whatmodel.sh](https://whatmodel.sh) does that, with a published method.
- No running evaluations ourselves.
- No fetching from sites whose terms forbid it, and no working around bot challenges or logins.
- No reading numbers out of images or charts.

### 1.3 Principles

1. **Raw first.** Model names, metric names and score text are stored exactly as the source wrote them.
   Matching and labelling happen at build time, so a wrong match is fixed by editing one line and
   rebuilding. Nothing ingested is ever rewritten.
2. **A column is one metric from one source.** Numbers from different sources are never put in the same
   column, so nothing incomparable is ranked together. Related columns can be grouped into a family.
3. **Weights are not the evaluation context.** Quantization, reasoning mode and effort, and agent
   scaffold are context on the row, not part of the model's identity.
4. **Dates carry provenance, and "unknown" is a valid date.**
5. **People edit config; the bot edits data.** `sources.yaml` and `curation/` are yours. `data/` is
   written only by the workflow.

---

## 2. How it works

```text
   you ──edit──►  sources.yaml, curation/*          (main branch)
                        │
   cron every 6h ───────┤  push to main ───────┐  manual "Run workflow"
                        ▼                       ▼
        ┌──────────────── update workflow (one Actions run) ────────────────┐
        │ 1. scrape   fetch each due source → extract rows → guard → diff   │
        │ 2. resolve  match model names, write reports                      │
        │ 3. commit   data/ changed? commit and push (bot)                  │
        │ 4. build    static site + data files from data/ and curation/     │
        │ 5. deploy   GitHub Pages                                          │
        └──────┬─────────────────────────────┬──────────────────────────────┘
               │ on a held or failing source │
               ▼                             ▼
        GitHub Issue (one per source)   https://llmbench.site
```

One workflow does all five steps because a push made with the workflow's own token does not start
another workflow. The data commit therefore cannot trigger a separate build, and it also cannot loop.

---

## 3. The flat file: `sources.yaml`

This is the only file you need to touch to add, change or remove a source.

```yaml
defaults:
  every: 6h            # how often to check
  run_by: independent  # independent | submitted | lab  (who ran the eval; see 6.3)

sources:
  # A YAML file in a GitHub repo. Field names are the source's own.
  - id: aider-polyglot
    name: Aider polyglot
    homepage: https://aider.chat/docs/leaderboards/
    fetch: github:Aider-AI/aider/aider/website/_data/polyglot_leaderboard.yml
    model: model
    key: dirname                 # the source repeats model names; this makes rows unique
    context: [edit_format]
    date: date
    scores: [pass_rate_2, pass_rate_1, percent_cases_well_formed]
    license: Apache-2.0
    terms: allowed

  # A CSV on a website. No `scores:` list means every numeric column is a score.
  - id: bfcl
    name: Berkeley Function Calling Leaderboard
    homepage: https://gorilla.cs.berkeley.edu/leaderboard.html
    fetch: https://gorilla.cs.berkeley.edu/data_overall.csv
    model: Model
    model_url: Model Link
    ignore: [Rank]
    lower_is_better: ["Total Cost ($)", "Latency Mean (s)", "Latency 95th Percentile (s)"]
    license: Apache-2.0
    terms: allowed

  # A Hugging Face dataset in "long" form: one row per (model, category).
  - id: arena-text
    name: Arena — text
    homepage: https://arena.ai/leaderboard      # for the link only; the site itself is not fetched
    fetch: hf:lmarena-ai/leaderboard-dataset
    config: text
    split: latest
    model: model_name
    metric: category             # each category becomes a column
    value: rating
    ci: [rating_lower, rating_upper]
    date: leaderboard_publish_date
    rolling: true                # ratings drift by design; see 5.4
    license: CC BY 4.0
    attribution: Arena Leaderboard Dataset by LMArena, CC BY 4.0
    terms: allowed

  # Anything that needs a join or custom logic points at a script.
  - id: epoch
    name: Epoch AI Benchmarking Hub
    homepage: https://epoch.ai/benchmarks
    fetch: https://epoch.ai/data/benchmark_data.zip
    plugin: epoch                # scripts/sources/epoch.ts — one zip, 92 files, differing shapes
    license: CC BY 4.0
    terms: allowed

  - id: whatmodel
    name: whatmodel.sh
    homepage: https://whatmodel.sh
    fetch: github:jakemanger/whatmodel/data
    plugin: whatmodel
    every: 1d
    license: CC BY-SA 4.0
    attribution: whatmodel.sh by Merlinsbeard Pty Ltd, CC BY-SA 4.0
    terms: allowed

  # A source you have decided not to use stays listed, with the reason.
  - id: artificial-analysis
    name: Artificial Analysis
    homepage: https://artificialanalysis.ai
    terms: blocked
    terms_note: Site terms allow personal non-commercial use only and forbid building a similar service.
```

### 3.1 Fields

| Field | Required | Meaning |
| :-- | :-- | :-- |
| `id`, `name`, `homepage` | yes | Identity and the link shown on the site |
| `fetch` | yes, unless blocked | `github:owner/repo/path` (globs allowed; each file's path is available as `_file`), `hf:owner/dataset` with `config`/`configs` and `split` (each config's name is available as `_config`), or any `https://` URL to CSV, TSV, JSON, JSON Lines, YAML, Parquet or Markdown (pipe tables, as in a README). ZIP and HTML need a plugin for now. |
| `format`, `rows` | no | Override format detection; dot path to the row list inside JSON or YAML |
| `model_label` | no | Column with the source's display name, when `model` is an identifier; used for matching |
| `model` | yes, unless `plugin` | Column holding the model name |
| `scores` | no | Columns that are scores. Omitted means every numeric column not named elsewhere. |
| `metric` + `value` | no | For long-form tables: the column naming the metric and the column holding the number |
| `key` | no | Column or columns that make a row unique when the model name alone does not |
| `context` | no | Columns describing how the model was run: quantization, reasoning effort, scaffold, edit format |
| `date`, `model_url`, `ci` | no | Evaluation date, link to the model, confidence-interval columns |
| `table` | no | Which Markdown table to read: its position (0 is the first) or text from the heading above it. For HTML pages (later): a CSS selector. |
| `render: browser` | no (Phase 4) | Load the page in headless Chromium first. Optional `capture:` URL pattern grabs the JSON the page loads. |
| `plugin` | no | Name of a script in `scripts/sources/` for sources that need custom logic |
| `ignore`, `lower_is_better`, `labels`, `family` | no | Columns to drop; direction; display names; grouping across sources (6.1) |
| `filter` | no | Keep only records where a column has the given value(s) |
| `unit`, `units` | no | `percent`, `fraction`, `elo` or a free-form unit, for all metrics or per metric. Default: `percent` when every value ends in `%`, else `score`. |
| `headline` | no | Metrics shown in the default "most covered" column choice; the rest (sub-scores) need "All". Default: all. |
| `every`, `rolling`, `min_rows` | no | Check interval; rating-style series (5.4); minimum rows before a run is trusted |
| `duplicates` | no | `hold` (default) or `drop`. What to do when the source repeats a row with nothing to tell the entries apart. `drop` leaves those scores out and logs it. |
| `round` | no | Decimals to keep for numeric scores. Only for computed values whose precision is noise (5.4). |
| `run_by` | no | Who ran the evaluations (6.3) |
| `run_by_from` | no | Who ran each row, from a column: `{ column: Data Source, values: { TIGER-Lab: independent, Self-Reported: lab } }` |
| `license`, `attribution` | yes, unless blocked | The data's licence as the source states it, or `none stated`. Shown on the site and on every download row. Non-commercial and unstated licences are labelled as such. |
| `terms` | yes | `allowed` or `blocked`. Only `allowed` sources are fetched. It is your record that you checked. A source is blocked only when its terms forbid reuse or automated access; a missing or non-commercial licence is not a reason (decided 2026-11-13). |

`npm run validate` checks the file against a schema. CI runs it on every pull request.

### 3.2 Adding a source

1. `npm run add-source -- <location>` fetches it, reads every record, lists the columns, and prints a
   draft entry: the model column, scores, columns to ignore (ranks), lower-is-better columns (cost,
   latency, error rates), a key when model names repeat, context columns, and the repository's licence
   where GitHub or Hugging Face states one. The draft says `terms: blocked` until you have read the
   source's terms. It also tries the draft and reports the rows and metrics it would give. *Built.*
   Asking an LLM to propose the mapping for awkward tables is still to come; the LLM would never
   touch the values.
2. Paste the entry into `sources.yaml`, set `license` and `terms`.
3. `npm run scrape -- --source <id> --dry-run` shows exactly what would be recorded and writes
   nothing. *Built.*
4. Commit. The next run ingests it and it appears on the site.

Structured files usually need 8 to 12 lines and no code. Of the launch sources, two need a plugin.

---

## 4. Repository layout

```text
llmbench/
├── sources.yaml                  # what to pull from                         (you)
├── curation/                     #                                           (you)
│   ├── aliases.csv               # source,raw_name,model_id[,note] — "*" for any source, "-" to block
│   └── models.yaml               # models to add to, or correct in, the catalogue
├── data/                         # written only by the workflow              (bot)
│   ├── sources/<id>/
│   │   ├── rows.jsonl            # current rows, verbatim, sorted
│   │   ├── history.jsonl         # append-only log of every change
│   │   ├── state.json            # upstream revision, etag, hash, row count, status
│   │   └── raw.*                 # raw payload, only when small and not pinned upstream
│   ├── catalog/models.jsonl      # canonical models, seeded from whatmodel
│   ├── resolved/aliases.csv      # every name: its model, how it matched, the qualifiers set aside
│   ├── resolved/unlisted.csv     # models not in the catalogue, each gathering agreeing names
│   └── reports/unmatched.csv     # names not in the catalogue, most-used first, with near misses
├── scripts/
│   ├── scrape.ts                 # fetch → extract → guard → diff
│   ├── resolve.ts                # model matching and reports
│   ├── build.ts                  # data/ → site/dist: pages, data files, browser scripts
│   ├── add-source.ts, report-issues.ts, validate.ts   (backfill.ts: Phase 4)
│   ├── lib/                      # fetchers, extractor, guards, diff, matcher, tags
│   ├── site/                     # page templates, data assembly, browser-code compiler
│   └── sources/                  # plugins: whatmodel.ts, epoch.ts
├── site/
│   ├── src/                      # the explorer (TypeScript; shared formatting and URL state)
│   └── static/                   # style.css
├── tests/
│   ├── fixtures/<id>/            # a saved payload and the rows it must produce
│   └── *.test.ts
└── .github/workflows/
    ├── update.yml                # scrape, commit, build, deploy
    └── ci.yml                    # validate, test, build on pull requests
```

TypeScript throughout, run directly by Node 24+ (type stripping), so there is no build step for the
scripts. Runners have gigabytes of memory, so whatmodel's 34 MB `results.json` is simply parsed.

`state.json` changes only when a source's data changes. When each source was last checked is a per-run
fact, kept in `.cache/last-run.json` (not committed) and read by the build in the same run, so an
unchanged check does not create a commit.

---

## 5. Data

### 5.1 Rows

`data/sources/<id>/rows.jsonl` holds one line per upstream row, sorted by key so that diffs stay small.

```json
{"key":"2025-02-25-20-23-07--gemini-pro","model":"Gemini 2.0 Pro exp-02-05","context":{"edit_format":"whole"},"date":"2025-02-25","scores":{"pass_rate_1":"20.4","pass_rate_2":"35.6","percent_cases_well_formed":"100.0"},"extra":{"total_cost":"0.0000"}}
```

- Scores are kept as the source's text (`"77.47%"`, `"1312 (+5/-4)"`). Numbers are parsed at build time.
- A row's identity is `key` when the source has one, otherwise the model name plus its context values.
- `extra` keeps every other column, so nothing from the source is lost.
- Rows from an aggregator also carry `upstream_url` and `run_by` per row, as whatmodel provides them.

### 5.2 History

`history.jsonl` gets one line appended whenever a cell changes:

```json
{"t":"2026-11-18T06:17Z","key":"…","model":"…","metric":"pass_rate_2","op":"change","from":"35.6","to":"36.0","rev":"<upstream commit>"}
```

Operations are `add`, `change`, `remove` and `return`. The site reads history from this file, not from
`git log`, so it stays cheap to build. Git still holds the full record as a backstop.

### 5.3 Dates

Three dates exist and they are kept apart:

- **Model release date** — on the model.
- **Evaluation date** — only when the source states one.
- **First seen** — the time of the cell's `add` event, accurate to one check interval.

A source's first import is its baseline. Baseline cells get no `add` event, and unless the source gave
them a date, the site says "listed before tracking began" instead of inventing one. Stamping every
existing score with the import day would put a false spike on every timeline. Timelines use model
release date by default.

For sources in git, `npm run backfill -- --source <id>` replays the file's upstream commit history to
recover real dates. Arena's dataset has a `full` split next to `latest`, which looks like its own
history and would need no replay; confirm when writing that entry.

### 5.4 Rating-style series

Elo ratings move on every update by design. For a source marked `rolling`, a changed value is a new
point in a series and not a correction, and at most one point per cell is recorded per week. The
mass-change guard does not apply to rolling sources.

Repository growth is the real cost. Arena publishes ratings with about 13 decimal places across 1,287
model-arena rows, and nearly every value moves on every update: committed daily, that is on the order
of half a gigabyte of history a year. So Arena is checked weekly, its ratings are kept to one decimal
(`round: 1`, which is what whatmodel does), and its rank and variance columns are dropped (rank is
derivable; the interval covers variance). That is about 0.5 MB compressed per update.

### 5.5 Raw payloads

When the source has a commit id (GitHub, Hugging Face), `state.json` pins it and the upstream repo is
the archive. Otherwise the raw payload is committed if it is under 2 MB. Larger ones are kept as a
workflow artifact and only their hash is committed.

---

## 6. Showing everything

### 6.1 Columns

Every column is `<source>:<metric>`, for example `bfcl:Overall Acc` or `arena-text:overall`. This needs
no curation and keeps unlike numbers apart.

A source can label its metrics and assign a `family`, such as `gpqa-diamond`. Columns sharing a family
are shown side by side on the benchmark page and can be added to the explorer together. whatmodel's
1,311 benchmark ids arrive with names and are used as families from the start.

### 6.2 Models

Rows from different sources line up only when their model names are matched to one catalogue entry.

- **Catalogue.** Seeded from whatmodel's `models.json`: 2,310 models, 1,230 of them LLMs (890 of those
  with a Hugging Face repo link, 917 with parameter counts). `curation/models.yaml` adds or corrects
  entries.
- **Matching**, in order (`scripts/lib/match.ts`): a line in `curation/aliases.csv`; a Hugging Face
  link on the row; an exact match on the normalised name against catalogue ids, names and repo names;
  the same after setting aside qualifiers; the same after a leading maker name that agrees with the
  model's provider. The parser (`scripts/lib/names.ts`) knows reasoning effort (`(High)`, `_xhigh`),
  thinking budget (`_32K`), thinking on or off, quantization (`FP8`, `NVFP4`, `Q4_K_M`), call mode
  (`(FC)`, `(Prompt)`), web search or grounding, release stage (`Preview`, `Beta`) and snapshot dates
  in every form the sources use (`2024-12-17`, `20250514`, `260428`, `0905`, `06-17`, `Aug 2024`).
  Qualifiers set aside become the score's context; ones the model's own name already states are
  dropped.
- **Normalisation keeps numbers apart.** A separator between two numbers survives as ".", so
  `OPT-1.3B` ≠ `OPT-13B` and `Qwen2.5-7B` ≠ `Qwen2-57B`; `+` reads as "plus", so `Command R+` ≠
  `Command R`. The Phase 0 matcher got the last one wrong on the live site.
- **Snapshots must agree.** When qualifiers are set aside, the candidates are the catalogue models
  with the same core name, and a stated snapshot date must agree with the model's: `GPT-4o (Aug 2024)`
  is `gpt-4o-2024-08-06`, and `Mistral Large (2411)` is never `mistral-large-2402`. An id that says one
  model while a repository name says another (`Gemma 2B` is the instruct model's id and the base
  model's repo) matches neither.
- **No fuzzy auto-matching.** A wrong merge silently mixes two models' scores, which is worse than a
  missing merge. Near misses go to `data/reports/unmatched.csv` as suggestions, ambiguous candidates
  first.
- **Every match is written to `data/resolved/aliases.csv`** with its method and qualifiers, so a change
  in matching shows up as a diff in the bot's commit.
- **Names outside the catalogue are models too.** Names whose core name and snapshot agree, across
  sources, share one "unlisted" model with its own page, shown in the explorer by default and marked
  "not in the catalogue". Fixing one is a line in `curation/aliases.csv`; adding it is a few lines in
  `curation/models.yaml`. `npm run validate` checks both files.

### 6.3 Who ran it

| `run_by` | Meaning | Example |
| :-- | :-- | :-- |
| `independent` | A third party ran the model | Epoch's own runs, Arena votes |
| `submitted` | Submitted to a leaderboard by the model or agent builder | SWE-bench and Terminal-Bench entries |
| `lab` | Reported by the model's maker | Model cards, release posts |

Shown as a badge on every score and available as a filter. This is whatmodel's taxonomy, so its rows
need no translation.

### 6.4 When several scores land in one cell

A model can have several rows in one column: re-runs, reasoning modes, scaffolds. The cell shows the
best one after the visitor's filters, labelled with its context, and `+n` for the rest. The popover
lists all of them. Pinning a context, such as non-thinking only, is a filter.

---

## 7. The site

Static: one HTML page per source, model and benchmark column so that links and search engines work on
GitHub Pages, and one interactive page, the explorer.

As built in Phase 2, without a framework. Astro and React were the plan; they turned out unnecessary.
`scripts/build.ts` renders every page from TypeScript template functions with automatic escaping, and
the explorer is plain TypeScript in `site/src/`, turned into browser modules by Node's own type
stripping. That means no bundler and no new dependencies, the browser code is type-checked with
everything else, and the formatting, URL-state and best-score code is shared between the pages, the
explorer and the tests. The whole site (about 2,000 pages) builds in about a second.

### 7.1 Explorer (home)

- **Rows are models, columns are whatever the visitor picks.** A searchable panel lists every source
  and metric, grouped by source, category or family, with the number of models each covers.
- **Sort** by any column. **Filter** by open weights, organization, parameter count, licence, release
  date, who ran it, quantization, and "has a score in the selected columns".
- **Presets** for common starting points: coding, agentic, math, arena, small models.
- **Compare mode.** Pick two to five models and see every metric where at least two have a score. This
  is the view that works best on sparse data.
- **Chart mode.** Any column against any other, or against release date or parameter count (log
  scale). One dot per model, coloured by open or API-only weights, the leaders labelled, a readout on
  hover or with the arrow keys, and the axes kept in the URL (`view=chart`, `x`, `y`). *Built in
  Phase 4.*
- **Provenance popover** on every cell: source link, the source's own model and metric text, date and
  where the date came from, who ran it, context, other scores, change history.
- **The whole view is in the URL**, so any table a visitor builds can be shared or bookmarked.
- **Export** the current view as CSV.

Sparsity sets the defaults. In whatmodel's LLM data the model-by-benchmark grid is about 2% filled,
the median model has 8 benchmarks and only 33 benchmarks cover 100 or more models. So the default view
shows the most-covered columns, hides models with fewer than three scores in view, sorts by release
date, and shows coverage counts on rows and columns.

Phase 0 finding: columns must be ranked by coverage among the models currently in view, not across all
time. All-time coverage favours old benchmarks (MMLU, GSM8K, HumanEval); models released in the last
12 months are mostly scored on GPQA Diamond, Arena, SWE-bench Verified and Humanity's Last Exam. With a
"released in the last 12 months" filter the default view goes from 24% to 36% filled.

As built: presets are the task tags (coding, agents & tools, math, knowledge & reasoning, chat &
writing, vision & documents, web search), taken from whatmodel's task groupings plus `tags:` in
`sources.yaml`. The column picker lists every metric by source with live coverage counts; sub-scores
(non-headline metrics) are behind a toggle. Filters: name or maker, release window, size by total
parameters, maker, open weights, permissive licence, who ran it (independent, submitted, lab), and
models not in the catalogue, and "plain runs only" (no quantized or web-search runs, from Phase 3's
normalised context). Cells support arrow-key navigation, and Enter opens the popover. Chart mode moves
to Phase 4.

URL parameters: `c` (a column id, repeated), `n` (how many most-covered columns), `tag`, `q`, `since`
(months), `open`, `perm`, `size` (max total B; negative means "over"), `maker`, `by` (run-by codes,
e.g. `01`), `um`, `min`, `sort` (a column id or `name`), `dir`, `m` (a model id for compare,
repeated), `view=compare`.

### 7.2 Pages

- `/sources/` — every source with status, last checked, last changed, licence and attribution.
- `/sources/<id>/` — status and any held-run reasons, licence, where the data is read from, every
  metric, every model name with how it was matched, and recent changes. Works with zero curation.
- `/models/<id>/` — every score for a model across all sources, with rank in each column; sub-scores
  folded away; each name the sources use for it; recent changes. Links to whatmodel.sh for memory needs
  and run commands.
- `/benchmarks/` — directory of all columns with a filter box. `/benchmarks/<source>/<metric>/` — the
  full leaderboard for one column, and links to the same benchmark in other sources (via `family`).
- `/method/` — how matching, dates and "best in cell" work.
- `/data/` — downloads (every score as CSV, Parquet and SQLite, plus models, benchmarks, names and
  sources as CSV), where the data lives, and its licences.
- `404.html`, `sitemap.xml`, `robots.txt`.

### 7.3 Data the site loads

The build writes `index.json` (sources, columns, models, tags) and one `cells/<source>.json` per
source: each score as a compact tuple with its run-by, date, context, source link, interval, the
source's own name for the model, and its change history. The explorer loads all of it (about 0.6 MB
compressed), so any column can be added instantly. All filtering and sorting happens in the browser.
A later option is an in-browser SQL console over the Parquet file.

---

## 8. The update run

### 8.1 Per source

1. **Due?** Skip unless `every` has elapsed, the source is new, or it was requested by hand.
2. **Fetch**, conditionally: the commit id for GitHub and Hugging Face, `ETag` or `Last-Modified`
   otherwise. Unchanged means stop.
3. **Extract** rows using the entry's field mapping or its plugin.
4. **Guard** (8.2). On failure nothing is written and an issue is opened.
5. **Diff** against `rows.jsonl`. Write the new rows file, append to history, update state.

### 8.2 Guards

| Guard | Trips when | Catches |
| :-- | :-- | :-- |
| Row drop | Fewer rows than `min_rows`, or under half the last good run | Partial loads, broken selectors |
| Missing column | A column the entry names is absent | Upstream renames |
| Mass change | More than 20% of existing cells changed at once | Shifted columns. Off for `rolling` sources. |
| Duplicate rows | Two rows share an identity | A missing `key` |
| Type flip | A score column that was numeric is mostly non-numeric | Layout changes |

A held source keeps its last good data. Its issue shows which guard tripped and a summary of the diff.
Release it by fixing the entry in `sources.yaml`, or by running the workflow by hand with
`accept: <id>` if the change is real. The issue closes itself when the source next succeeds.

### 8.3 Workflow

```yaml
# .github/workflows/update.yml
name: update
on:
  schedule:
    - cron: "17 */6 * * *"        # off the hour: scheduled runs are delayed most at :00
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      source: { description: "Only this source id", required: false }
      accept: { description: "Accept a held run for this source id", required: false }

concurrency: { group: update, cancel-in-progress: false }

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions: { contents: write, issues: write }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: "lts/*", cache: npm }
      - run: npm ci
      - run: npm run scrape
        env:
          ONLY_SOURCE: ${{ inputs.source }}
          ACCEPT_SOURCE: ${{ inputs.accept }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
      - run: npm run resolve
      - name: Commit data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data
          git diff --cached --quiet && exit 0
          git commit -m "data: update $(date -u +%Y-%m-%dT%H:%MZ)"
          for i in 1 2 3; do git push && break; git pull --rebase; done
      - run: npm run build
      - uses: actions/upload-pages-artifact@v5
        with: { path: site/dist }

  deploy:
    needs: update
    runs-on: ubuntu-latest
    permissions: { pages: write, id-token: write }
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v5
```

A commit happens only when data changed, so `main` gets a few bot commits a day, not one per run. The
site is rebuilt on every run so that "last checked" stays current. One-time setup (done): Pages
source set to GitHub Actions, and the custom domain `llmbench.site` set on the repository. The
committed `.github/workflows/update.yml` also carries the run cache (`actions/cache`), a `resolve`
step after scraping, and an issue step that runs even when scraping fails.

`ci.yml` runs on pull requests: `validate`, type check, unit tests, every source's fixture test, and a
site build. It has no write permissions and no secrets.

---

## 9. GitHub limits that shape the design (checked 2026-11-12)

| Fact | Consequence |
| :-- | :-- |
| Standard runners are free in public repositories | $0 to run |
| Scheduled runs are delayed under load, worst at the top of the hour, and can be dropped | Freshness target is "within a day", not minutes. Cron runs at :17. |
| Scheduled workflows run only from the default branch | `update.yml` lives on `main` |
| In a public repo, scheduled workflows are disabled after 60 days without repository activity | The bot's data commits to `main` should count as activity. If the workflow is ever disabled, re-enable it from the Actions tab. |
| A push made with the workflow's token starts no other workflow and no Pages build | Scrape, build and deploy are one workflow |
| The workflow token gets 1,000 GitHub API requests per hour | Plenty; no personal token needed for GitHub sources |
| A job may run 6 hours | Not a constraint. A full run should take minutes. |
| Files over 50 MiB warn and over 100 MiB are blocked; repositories should stay under 1 GB | Sorted text files, no binaries, no large raw payloads. whatmodel's rows are split by category. |
| Pages: site up to 1 GB, soft 100 GB per month, 10-minute deploy limit, not for commercial services | Comfortable. If the site ever carries ads or outgrows the bandwidth, host the same files on Cloudflare Pages. |
| Failure emails for scheduled runs go to whoever last edited the cron line | That should be you |

---

## 10. Sources (checked 2026-11-12)

### 10.1 Launch set

| Source | Provides | Location | Licence |
| :-- | :-- | :-- | :-- |
| **whatmodel** | 37,490 results across 1,311 benchmark ids, each with a source URL and who ran it; the model catalogue | `jakemanger/whatmodel`, `data/` | CC BY-SA 4.0 |
| **Epoch AI Benchmarking Hub** | About 90 CSVs in one 2.3 MB zip, one per benchmark: Epoch's own runs (GPQA Diamond, FrontierMath, SWE-bench Verified, OTIS Mock AIME and more) and mirrored external leaderboards (WeirdML, SimpleBench, METR time horizons, GDPval and more) | `https://epoch.ai/data/benchmark_data.zip` | CC BY 4.0, stated in the zip's README |
| **Arena** | Ratings with confidence bounds for 23 arenas (text, vision, webdev, search, document, agent, image and video), each with a `latest` and a `full` split | Hugging Face dataset `lmarena-ai/leaderboard-dataset`, last updated 2026-11-12 | CC BY 4.0 |
| **BFCL** | Function calling: about 30 accuracy, cost and latency columns | `https://gorilla.cs.berkeley.edu/data_overall.csv` | Apache-2.0 |
| **Aider polyglot** | Code editing; several runs per model with dates | `Aider-AI/aider`, `aider/website/_data/polyglot_leaderboard.yml` (last changed 2025-10-04) | Apache-2.0 |

As built in Phase 1:

- **Epoch** is a plugin driven by the zip's own `benchmark_metadata.csv`, which names each file's score
  column and scale, so nothing is guessed. It imports Epoch's own runs (15 metrics, including the Epoch
  Capabilities Index). The `_external` files are Epoch's copies of other leaderboards; Epoch asks users
  to credit those original sources, whose terms we have not reviewed, so they are off
  (`include_external: false`).
- **Arena** imports six arenas (text, text with style control, webdev, vision, search, document), all
  categories, 76 metrics; one "overall" per arena is a headline column. Its data repeats one model name
  with different ratings, so it uses `duplicates: drop` (section 3.1).
- **whatmodel rows are not skipped** when we fetch the same upstream directly. Each source is its own
  column, so nothing is counted twice in a cell, and skipping would lose data until matching is complete.

First-run matching: whatmodel 1,227 of 1,227 model names, Epoch 529 of 676, Arena 470 of 549,
BFCL 91 of 109, Aider 55 of 68. After Phase 3: Epoch 614, Arena 522, BFCL 107, Aider 57. The rest
are rows of their own, marked "not in the catalogue", and listed in `data/reports/unmatched.csv`.

### 10.2 Next — live and openly licensed

Added in Phase 4:

- **τ²-bench** (`sierra-research/tau2-bench`, MIT): one `submission.json` per leaderboard entry, and a
  manifest of the ones the current text leaderboard shows. A plugin (`scripts/sources/tau2.ts`) reads
  those, leaves out the voice and legacy boards, and never copies the contact details the files carry.
  Runs by Sierra, the benchmark's authors, are "independent"; the rest are "submitted". 30 entries.
- **Vectara hallucination leaderboard** (Apache-2.0): a Markdown table in the repository's README,
  read with no code through the new Markdown format. 111 models.

Added in the second Phase 4 slice, after the licence decision in 10.3:

- **SWE-bench** (CC BY-NC 4.0, plugin): five boards from one file. Runs where the SWE-bench team put
  every model in the same minimal agent ("bash only") are separate columns from systems submitted by
  their builders, so a model's score never silently becomes the best of any scaffold. 323 entries.
- **LiveBench** (no licence stated, plugin): read from livebench.ai's own files, because the GitHub
  copy stopped updating in mid-2026. All eleven 1.0 releases and the 2.0 releases, each release its
  own columns. Category averages, the weighted 2.0 Overall and cost per task are computed the way the
  site computes them, and were checked against its pages. 904 rows.
- **Terminal-Bench** (Apache-2.0, plugin): versions 4.1, 2.1 and 2.0 from the leaderboard's open
  JSON endpoint. Entries are agent and model systems; the agent is context. 217 entries.
- **No code:** Lech Mazur's NYT Connections, writing, debate, Elimination Game, generalization,
  sycophancy, Step Game and confabulations benchmarks (Markdown tables in each README), Kagi's LLM
  benchmark (a Markdown table in its docs), LLM Chess (CSV, Apache-2.0) and MMLU-Pro (CSV on Hugging
  Face, Apache-2.0, with `run_by_from` telling TIGER-Lab's runs from self-reported scores).

Found and not yet added: EQ-Bench 3 and 4 and Creative Writing v3 (CSV inside the site's JavaScript;
needs a small plugin), SimpleBench (a JavaScript literal), Vals.ai (per-benchmark JSON behind hashed
URLs), MathArena (tables as HTML inside JSON). OpenCompass, HELM, LiveCodeBench, BigCodeBench and the
Open LLM Leaderboard are stale or tiny.

Checked and not added (2026-11-13):

- **Terminal-Bench 4.0**: the results live in Harbor Hub (`hub.harborframework.com`), not in the
  repository; the repository only holds run configurations. Needs that service's terms.
- **MathArena** and **ARC Prize**: their leaderboards are served from their own websites; the
  repositories hold code and model outputs, not leaderboard tables. Needs the sites' terms.
- **EQ-Bench 3**: a 26 MB gzipped file, mostly judge transcripts, last updated 2026-05-31. whatmodel
  carries its results.
- **Hugging Face eval results** (`.eval_results/*.yaml` in model repos): still to look at.

whatmodel already carries most of these at pinned revisions, so a direct entry is worth adding only
where freshness or history matters.

### 10.3 Licences and terms (decided 2026-11-13)

llmbench is non-commercial. A missing licence or a non-commercial licence is not a reason to leave a
source out: such sources are fetched, labelled on their source page, on the data page and in every
download (`source_license` on each score row, `reuse` in the sources table), and credited. The
compilation stays CC BY-SA 4.0 for what we add (selection, matching, arrangement); each source's
scores keep their own licence. A source stays out only when its terms forbid reuse or automated
access:

| Source | Why it is blocked |
| :-- | :-- |
| ARC Prize | Its terms forbid access "through automated or non-human means, whether through a bot, script or otherwise". |
| Scale SEAL (including Humanity's Last Exam) | Its terms forbid accessing the sites "in order to build a competitive product or service". Whether an aggregator counts is the owner's call. |
| Artificial Analysis | whatmodel's ledger records its terms as personal, non-commercial use only and no building a similar service. |

### 10.4 Not usable

| Source | Why |
| :-- | :-- |
| Open LLM Leaderboard v2, EvalPlus, BigCodeBench | Frozen since 2025-03, 2024-12 and 2025-04. Import once as archives if wanted; never polled. |
| LiveCodeBench | Site repo untouched since 2025-08; no data file found in its `public/` folder |
| arena.ai website | whatmodel's ledger records its terms as forbidding scrapers, and it serves a bot challenge. Use the dataset. |

"Accept any site" has one hard edge: a site that forbids reuse, or that only answers a real logged-in
browser, stays out. Tell me which other sites you rate and I will check each one's data location and
terms the same way.

---

## 11. Operations

- **Alerts.** One issue per held or failing source, opened and closed by the workflow. GitHub emails
  you when a run fails outright.
- **Unmatched models.** `data/reports/unmatched.csv` is regenerated every run, most-used names first.
- **Tests.** Every source has a saved payload and the rows it must produce. Unit tests cover the diff,
  the guards, the name parser and the matcher.
- **Security.** Fetched content is data and is never executed. The site renders every scraped string as
  text and accepts only `http` and `https` links. The browser step runs without tokens in its
  environment. CI on pull requests has no secrets and read-only permissions.
- **Politeness.** Conditional requests, a six-hour default interval (daily or weekly for slow
  sources), up to three attempts with backoff on network errors, 429 and 5xx, and `robots.txt`
  honoured for HTML and browser fetches. The User-Agent is generic unless the repository variable
  `LLMBENCH_USER_AGENT` names the deployment (for example `llmbench (+https://llmbench.site)`).
- **Run cache.** When each source was last checked, and HTTP validators, live in `.cache/last-run.json`.
  The workflow carries it between runs with `actions/cache`; if it is lost, every source is simply due.
- **Licensing.** Each source's licence and attribution are shown on its page and carried on every
  download row. The compilation is CC BY-SA 4.0 because it builds on whatmodel's; non-commercial and
  unstated source licences are labelled (10.3).

---

## 12. Delivery

Durations are rough estimates for one developer.

**Phase 0 — look at real data (1–2 days).** Repo skeleton. Import whatmodel into `data/`. Render one
plain table. *Exit:* you have seen the real matrix and its sparsity.

**Phase 1 — the loop (about a week).** `sources.yaml` schema and validation. Fetchers for GitHub,
Hugging Face and plain URLs. The field-mapping extractor and the two plugins. Diff, history and guards.
`update.yml` with commit and Pages deploy. The five launch sources.
*Exit:* the site is live; an upstream change shows up after the next run with a history entry; a
deliberately broken source opens an issue and leaves published data alone.
*Done 2026-11-12.* The history and broken-source checks were run locally; the issue step was checked
in dry-run mode. The live deploy happens on the first workflow run after merge. Also pulled forward
from Phase 3: exact-match name matching (with qualifiers such as "(High)" or a snapshot date set
aside as context), `curation/aliases.csv` overrides, and the matched and unmatched reports. Guards
caught a real upstream problem on the first run (Arena listing one model twice).

**Phase 2 — the explorer (about a week).** Column picker, sort, filters, URL state, popovers, compare
mode. Source, model and benchmark pages.
*Exit:* a visitor can build and share a table from any mix of sources.
*Done 2026-11-13.* Checked in the browser: a shared link with four columns from four sources, filters
and a sort reopened exactly; CSV export, compare mode, the popover with keyboard focus handling, the
column picker, and phone width. Built without Astro or React (section 7).

**Phase 3 — matching and exports (about a week).** Name parser, matcher, curation files, reports. CSV,
Parquet and SQLite downloads. Method page.
*Exit:* the same model from two sources sits on one row, and a wrong match is a one-line fix.
*Done 2026-11-13.* Names outside the catalogue fell from 257 to 102, and those left form 96 models of
their own, joined across sources by core name. Every new and changed match was reviewed before the
curation lines were written. Two matches that were live on the site turned out wrong and are now
right: "Command R+ (08-2024)" sat on Command R's row (the `+` was dropped), and Epoch's "Mistral
Large 2 (Jul 2024)" sat on the November model. 30 lines of `curation/aliases.csv` cover cases the rules
cannot know (Arena's undated "Command R" is the March 2024 release). Downloads: about 48,700 scores;
the Parquet file is 0.9 MB, the CSV and SQLite files about 12 MB each. SQLite needs no dependency
(`node:sqlite`); Parquet uses `hyparquet-writer`.

**Phase 4 — breadth (ongoing).** More sources. `render: browser` support. History backfill.
`add-source` with LLM-assisted mapping. Chart mode. Optional SQL console.
*First slice, 2026-11-13:* τ²-bench (plugin) and Vectara (Markdown table) added; SWE-bench (CC BY-NC)
and LiveBench (no licence) recorded as blocked; Markdown pipe tables as a source format;
`npm run add-source` without the LLM step; `scrape --dry-run`; chart mode; matching learned `4p7` as
4.7, year-month snapshots (`-2025-07`), cloud version tags (`-v1:0`), and curation lines that cover
`org/name`.
*Second slice, 2026-11-13:* the licence rule in 10.3; SWE-bench, LiveBench (1.0 and 2.0) and
Terminal-Bench as plugins; eleven more sources with no code (10.2); `source_license` on every
download row; `run_by_from`; HTML entities and repeated headers in Markdown tables. Matching learned
that Claude names come in both orders ("Claude 4 Sonnet", "Claude Sonnet 4"), API-style run settings
(`-thinking-64k`, `-high-effort`, "Max Effort", `-nothinking`), Together's `-Instruct-Turbo` as FP8,
`amazon.nova-*` maker prefixes, and that a model named "… Thinking" is its own model (a name with
"thinking" goes to it only when the dates agree). 21 sources, about 75,000 scores.
Still to do: the SQL console, `render: browser` (no source needs it yet), history backfill, the LLM
step in `add-source`, and the sources found but not yet added (10.2).

---

## 13. Risks and exits

| Risk | Mitigation |
| :-- | :-- |
| `data/` history bloats the repository | Sorted text, small diffs, no binaries. If it passes about 500 MB, move `data/` to its own branch or repo; the scripts only need a path. |
| Bot commits on `main` get in your way | They touch only `data/`, so `git pull --rebase` never conflicts. Same exit: a `data` branch. |
| Scheduled runs are late or skipped | Acceptable for a six-hour cadence. "Run workflow" forces one. |
| A site blocks GitHub's runner addresses | Nothing to do; that source stays out. |
| Automatic matching merges two different models | Exact matches only, every match committed and diffable, one-line override. |
| The data outgrows a browser | Per-source files are already loaded on demand; add per-column files if needed. |

A server-based design (the earlier Cloudflare version) would only be worth returning to for
sub-hourly freshness, a write API, or an interactive admin screen.

---

## 14. What the review of the original plan established

These findings shaped this version and remain true whatever the hosting:

- Half of the original "day one" sources were frozen, and one did not exist.
- Two of the original sources (Artificial Analysis, the Arena website) were to be scraped against their
  terms.
- Real sources repeat model names, so rows need their own key.
- Stamping first-import scores with the import date falsifies every timeline.
- Scores measured differently must not share a column.
- "Independent" and "vendor" are not enough; leaderboard submissions are a third kind.
- The model-by-benchmark grid is about 2% filled, so the default view has to be chosen for sparsity.
- LLMs may describe a table's structure, and must never supply its numbers.
