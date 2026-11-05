# sec-funding-signals

Finds companies that just raised money, from public SEC Form D filings on EDGAR. Single-file bundle:
`dist/sec-funding-signals.mjs` (Node 20+, no install, no dependencies). Unofficial; not affiliated with the SEC.

```sh
node dist/sec-funding-signals.mjs setup --email "<your email>"     # once, in your working folder
node dist/sec-funding-signals.mjs doctor
node dist/sec-funding-signals.mjs search --keywords physical-ai --since 30d --out-dir out
node dist/sec-funding-signals.mjs profile init --preset ai-data --out profile.json
node dist/sec-funding-signals.mjs search --profile profile.json --since 30d --sample 10
node dist/sec-funding-signals.mjs annotate --in out/sec-funding-2026-01-01.json --judgments judgments.json
```

Only two hosts are ever contacted, `efts.sec.gov` (full-text search) and `www.sec.gov` (each filing's
`primary_doc.xml`); `src/allowlist.js` refuses everything else before a request is made. Requests identify as
`sec-funding-signals <your email>` and are limited to 4 per second.

Develop: edit `src/`, then `npm run build && npm test`. `dist/sec-funding-signals.mjs` is committed; rebuild it
with every source change. Tests run offline against mocked `fetch` and the synthetic filings in `tests/fixtures/`.
The example profiles in `../profiles/` mirror `src/presets.js` (a test keeps them in step).
See `../SKILL.md` for commands, flow and rules.
