# linkedin (shared engine)

The tools behind `linkedin-find-people`, `linkedin-outreach`, `linkedin-replies` and `linkedin-job-signals`. Not a skill on its own: each
of those skills finds this folder through `ENGINE` (see its SKILL.md) and runs the scripts here.

- `scripts/search_people.js`, `scripts/poll.js`, `scripts/search_jobs.js`: page snippets, run in the user's own signed-in linkedin.com tab.
- `scripts/find_people.py`, `scripts/outreach.py`, `scripts/replies.py`: ledgers (Python 3 stdlib, no network);
  `scripts/li_common.py` holds what they share.
- `scripts/job_signals.py`: the job-signals ledger (Python 3 stdlib). The only script that makes network calls: it
  reads LinkedIn's public, logged-out job pages (no cookies sent, paced, capped, stops at the first block).
- `references/endpoints.md`: the plain-LinkedIn endpoints and which are verified; `references/job_signal_presets.json`:
  the example profiles.
