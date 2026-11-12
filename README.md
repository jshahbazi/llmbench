# llmbench

LLM benchmark results from every listed leaderboard, side by side. Every number keeps its source
link, and you choose which columns to compare.

The design and roadmap are in [docs/llm-benchmark-aggregator-plan.md](docs/llm-benchmark-aggregator-plan.md).
This is **Phase 0**: one source (whatmodel.sh) imported and shown as a plain table.

## Run it

Needs Node 24 or later (it runs the TypeScript directly) and Python 3 for the preview server.

```sh
npm install
npm run scrape    # fetch every allowed source in sources.yaml into data/
npm run build     # turn data/ into site/dist/
npm run preview   # serve site/dist at http://localhost:4321
```

Other commands: `npm run validate` checks `sources.yaml`, `npm test` runs the tests,
`npm run typecheck` type-checks. `npm run scrape -- --source whatmodel --force` re-reads one source
even if it has not changed upstream.

## Where things live

| Path | What | Edited by |
| :-- | :-- | :-- |
| `sources.yaml` | What to pull from | you |
| `data/sources/<id>/` | Each source's rows exactly as published, its metrics, its state | the scraper |
| `data/catalog/models.jsonl` | Canonical models, seeded from whatmodel.sh | the scraper |
| `scripts/` | Scraper, build, source plugins | code |
| `site/static/` | The page | code |

## Adding a source

In Phase 0 only plugin sources work (`scripts/sources/<name>.ts`). Plain entries in `sources.yaml`
that map columns of a CSV, JSON or YAML file arrive in Phase 1.

## Licence

Code: MIT (`LICENSE`). Data: CC BY-SA 4.0, with every source's own licence and attribution kept; see
`DATA-LICENSE.md`.
