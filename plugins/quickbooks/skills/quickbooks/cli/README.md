# qbo

Operate QuickBooks Online through a signed-in browser. Single-file bundle: `dist/qbo.mjs` (Node 20+, no install).

```sh
node dist/qbo.mjs doctor
node dist/qbo.mjs list invoices --where "Balance > '0'"
node dist/qbo.mjs report pandl --from 2026-01-01 --to 2026-09-30 --method accrual --csv pl.csv
node dist/qbo.mjs create customer --name "Acme"          # dry run
node dist/qbo.mjs --yes create customer --name "Acme"    # applies
```

Develop: `npm install`, edit `src/` or `../page/*.js`, then `node scripts/gen-snippets.mjs && npm run build && npm test`.
`dist/qbo.mjs` is committed; rebuild it with every source change. See `../SKILL.md` for runtimes and rules.
