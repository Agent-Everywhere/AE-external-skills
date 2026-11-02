# linkedin (shared engine)

The tools behind `linkedin-find-people`, `linkedin-outreach` and `linkedin-replies`. Not a skill on its own: each
of those skills finds this folder through `ENGINE` (see its SKILL.md) and runs the scripts here.

- `scripts/search_people.js`, `scripts/poll.js`: page snippets, run in the user's own signed-in linkedin.com tab.
- `scripts/find_people.py`, `scripts/outreach.py`, `scripts/replies.py`: ledgers (Python 3 stdlib, no network);
  `scripts/li_common.py` holds what they share.
- `references/endpoints.md`: the plain-LinkedIn endpoints and which are verified.
