# sourcewell

Read-only research CLI for Sourcewell's public cooperative-purchasing data. Single-file bundle:
`dist/sourcewell.mjs` (Node 20+, no install, no dependencies). Unofficial; not affiliated with Sourcewell.

```sh
node dist/sourcewell.mjs doctor
node dist/sourcewell.mjs contracts search --q "construction equipment" --field description
node dist/sourcewell.mjs bids list --status open
node dist/sourcewell.mjs agencies list --state UT --format csv
node dist/sourcewell.mjs watch init --out watch.json
node dist/sourcewell.mjs watch run --config watch.json --state-dir ~/.sourcewell-watch --format md
```

`watch run` is the daily alert: it diffs bids, awards and contracts against the last snapshot in `--state-dir`
(`src/watch.js`; the example config is embedded in `src/watch-example.js` and mirrored in `../watch.example.json`,
which a test keeps in step). A failed fetch exits non-zero and never overwrites `latest.json`.

Develop: edit `src/`, then `npm run build && npm test`. `dist/sourcewell.mjs` is committed; rebuild it with
every source change. Tests run offline against mocked `fetch` and the fixtures in `tests/fixtures/`.
See `../SKILL.md` for commands, flows and rules.
