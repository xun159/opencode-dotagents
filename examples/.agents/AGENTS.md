# .agents/AGENTS.md

Ambient instructions every AI coding tool reads. Put conventions that apply to
the whole machine in `~/.agents/AGENTS.md`, and conventions for this project in
`./.agents/AGENTS.md`. They are injected into the system prompt in that order.

- Keep database queries in `src/database`.
- Run `bun typecheck` after changing TypeScript.
