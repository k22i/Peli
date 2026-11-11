# Peli: notes for agents

## Shared memory

Claude Code and Codex share one memory in `.agents/memory/`.

- At the start of a session, read `.agents/memory/MEMORY.md` (the index), then open any file that looks relevant to the task.
- When you learn something worth keeping across sessions (user preferences, corrections, project decisions, pointers to external resources), save it there. One fact per file, with this frontmatter:

  ```markdown
  ---
  name: <short-kebab-case-slug>
  description: <one-line summary, used to decide relevance>
  metadata:
    type: user | feedback | project | reference
  ---

  <the fact; for feedback and project, follow with **Why:** and **How to apply:** lines. Link related memories with [[name]].>
  ```

- Update an existing file rather than adding a duplicate. Delete memories that turn out to be wrong.
- Add or update a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`). Keep the index to one line per memory, with no frontmatter.
- Don't save what the repo already records (code structure, git history, this file). Never put secret values in memory; point to the git-ignored `.env` file instead.
- Commit memory changes to `main` with the work they came from, so the other agent sees them.
