# Git Conventions

## Commit Format
phase({N}): {concise description of what changed}

Examples:
- phase(1): scaffold extension + webview workspaces with esbuild and vite
- phase(2): add Spike R3/R5 harnesses and record outcome D
- phase(5): implement consolidated tool registry with transaction batching
- fix: re-resolve track ref by name when index shifts mid-turn

## Branch Naming
- Feature: phase/{N}-{short-description}
- Fix: fix/{issue-description}
- Experiment: experiment/{description}  (use for the spike harnesses — they are throwaway)

## Rules
- Never force-push to main/master
- Stage specific files, not `git add .`
- **Never commit the Anthropic API key, `.env`, the runtime `config.json` from the storage directory, or any `.ablx` build artifact**
- Add to `.gitignore`: `node_modules/`, `dist/`, `*.ablx`, `.env`, `.claude/settings.local.json`, `.claude/state/`
- PR titles under 70 characters
- PR body includes: Summary, Test Plan, the phase reference, and (for branched phases) the Spike R3 outcome it targets
