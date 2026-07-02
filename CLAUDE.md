# Project Rules

These rules are permanent and apply to every change made in this codebase, regardless of feature or phase.

1. **Never duplicate code.** If similar logic already exists (e.g. autocomplete, status messages, table rendering), extend or reuse it rather than writing a parallel version.
2. **Always reuse existing components.** Check `js/utils.js` and existing UI patterns (`status-box`, `card`, autocomplete list, etc.) before building something new.
3. **Keep files modular.** One concern per file. Don't let unrelated logic (e.g. UI rendering + API calls + business logic) pile into a single file.
4. **Never create unnecessary files.** Only add a new file when there's a real, distinct concern that doesn't belong in an existing one.
5. **If a file becomes too large, recommend splitting it** — flag this explicitly rather than silently letting a file grow unbounded.
6. **Prefer reusable helper functions** over copy-pasted logic, even for small snippets.
7. **Keep code readable.** No cleverness at the expense of clarity. No comments explaining *what* the code does — only *why*, when non-obvious.
8. **Maintain consistent UI.** Reuse existing CSS variables, components, and interaction patterns from `css/styles.css` rather than introducing new visual styles.
9. **Never break existing features.** Every change must be checked against existing functionality before being considered done.
10. **Always think about scalability.** This app is expected to grow to 60-80+ features — avoid decisions that only work at the current size.
11. **Every feature must feel like it belongs in the project** — consistent naming, structure, and UI language with what already exists.
12. **After finishing every feature, self-review the code for bugs and improvements** before presenting it as done.

## Context
- Internal tool for an accounting/audit firm in Nepal, max 8 users.
- Current stack: static HTML/CSS/vanilla JS, no build tooling, Supabase (Postgres + Auth-adjacent via Google OAuth), Google Drive/Gmail APIs.
- See prior architecture review and phased roadmap (Phase 1-5) discussed with the user for planned direction — Phase 1 prioritizes fixing existing Critical/High findings before new feature work compounds them.

## Git Workflow

This project uses a proper Git workflow as of the migration off manual GitHub uploads (old upload history preserved at the `archive/pre-git-migration` tag). Every change follows the same sequence:

1. **Feature → Review → Commit → Push.** Implement the change, review it (self-review for bugs/edge cases/regressions, per rule 12 above), then commit, then push — in that order. Never push unreviewed or uncommitted work.
2. **One logical change per commit.** A commit represents a single, coherent change with a clear reason to exist. Don't bundle an unrelated fix, a feature, and a cleanup into one commit — split them, even if it means more commits for one conversation's worth of work.
3. **Never rewrite history unless explicitly approved.** No `--amend`, `rebase`, or force push on any commit that's already been pushed, without asking first and getting an explicit yes. History rewrites are a deliberate, occasional exception — not a routine tool.
4. **Never push without explicit approval.** Committing locally is fine to do proactively; `git push` always requires the user's go-ahead first, every time, no standing approval.
