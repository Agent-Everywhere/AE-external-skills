# Claude Desktop deep links

Source: Anthropic's help article at <https://support.claude.com/en/articles/14729294>. Re-read it if a
link stops working; these are documented but may change.

| Task type | Link |
|---|---|
| Chat | `claude://claude.ai/new?q=<urlencoded prompt>` |
| Cowork | `claude://cowork/new?q=<urlencoded prompt>` |
| Code | `claude://code/new?q=<urlencoded prompt>&folder=<urlencoded path>` |

Open one with macOS `open`:

```sh
open "claude://cowork/new?q=Run%20the%20onboarding%20skill%20on%20a%20sample%20company"
```

`scripts/desktop.py open --mode cowork|chat|code --prompt-file F [--folder PATH] [--dry-run]` builds the
URL with full percent-encoding (spaces, newlines, `&`, `#`, `%`, quotes, non-ASCII) and opens it.
`--dry-run` prints the URL instead.

## Behavior

- **Prefill only.** The link opens a new task with the prompt in the message box. It never submits;
  someone must press Send (this skill clicks it).
- **About 14,000 characters** of prompt at most. The helper refuses longer prompts. For bigger input,
  put the material in a file the task can read and prefill a short prompt that names it.
- **`folder` (Code mode)** makes Desktop show a confirmation dialog before it uses that folder. The
  user should confirm it; do not click through a folder-access dialog on your own initiative.
- A **caution banner** appears on prompts that came from a link. That is expected; it moves the layout,
  so screenshot before clicking Send.
- The app must be installed. If it is not running, `open` launches it; sign-in is still required.
- Encode with `safe=""` semantics: `/` and `:` inside the prompt are encoded too, so the prompt stays
  one `q` value.

## Choosing a mode

- **Cowork:** agentic file and tool work; best for dry-running a skill end to end.
- **Chat:** plain conversation.
- **Code:** a coding session rooted in a folder.
