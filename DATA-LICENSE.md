# Data licence

The code in this repository is MIT-licensed (see `LICENSE`). The benchmark data under `data/`, and
the files the site builds from it, are a different matter.

- **Our compilation** of that data (the selection, matching and arrangement) is licensed under
  [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/),
  because it builds on the whatmodel.sh compilation, which is CC BY-SA 4.0.
- **Each source keeps its own licence.** `sources.yaml` records the licence and attribution for every
  source we fetch, and every row of the downloads carries it (`source_license`). For results that
  reach us through whatmodel.sh, the original source of each number is in its row (`upstream_url`,
  `upstream_source`) and that source's licence and attribution are in
  `data/sources/whatmodel/upstream-sources.jsonl`.
- **Non-commercial sources.** Some sources are licensed for non-commercial use only (for example
  SWE-bench, CC BY-NC 4.0, and the CAIS AI Dashboard, whose terms allow not-for-profit and
  educational use with the credit "Reproduced with permission of Center for AI Safety, Inc").
  llmbench is a non-commercial project. If you reuse the data
  commercially, leave out the rows whose `source_license` is non-commercial (`reuse` is
  `noncommercial` in the sources table).
- **Sources with no licence.** Some sources state no licence (`none stated`). Their scores are
  reproduced as factual results, with credit to the source. A source is left out only when its terms
  forbid reuse or automated access.
- **The model catalogue** (makers, release dates, sizes, licences, context windows) is merged from
  whatmodel.sh (CC BY-SA 4.0), [models.dev](https://models.dev) (MIT), Epoch AI's
  [Data on AI Models](https://epoch.ai/data/ai-models) (CC BY 4.0) and the Hugging Face Hub's model
  API (parameter counts and each repository's own licence tag). The `catalogue_source` column of the
  models download says which feed each model's entry came from.
- **Removal.** If you run a source and want it credited differently or removed, open an issue.
- No source endorses this project. Data is provided as-is, without warranty.
