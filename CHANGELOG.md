# Changelog

All notable changes to Git Compass are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Create Pull Request** form inside VS Code: base branch, title, description (from the repository's pull request template or your commits), reviewers, labels, draft, and optional AI drafting. Offers to push the branch first, with an explicit refspec.
- **Merge pull requests** from Launchpad with squash, merge commit, rebase or auto-merge when checks pass, optional branch deletion, and warnings for failing checks, missing approval, conflicts or drafts.
- **Conflicts view** that appears during a merge, rebase, cherry-pick or revert: correct current/incoming labels, merge editor, accept a side, mark resolved, AI-suggested resolutions, and Continue, Skip or Abort. A status bar item shows how many files still conflict.
- **Resolve a pull request's conflicts locally** and **Push Current Branch** to update it.
- **Branch actions**: merge into the current branch (merge commit, fast-forward only or squash), rebase the current branch onto another, and update the current branch from the base branch.
- Settings `gitCompass.views.conflicts.enabled`, `gitCompass.pr.defaultDraft` and `gitCompass.pr.deleteBranchAfterMerge`.

## [0.1.0] - 2026-11-10

First public preview.

### Added
- **Side bar views**: Commits (with unpushed commits marked), Branches, Remotes, Stashes, Tags, Worktrees and Launchpad.
- **Inspect views**: File History, Line History, Compare (branch plus working tree against any branch or tag) and Search Commits (message, author, file, `-S`, `-G`, SHA).
- **Launchpad**: open pull requests grouped by what needs you, with pin, snooze, merge, check out and open-in-worktree actions, plus a status bar count. Uses the GitHub CLI.
- **Editor**: current-line blame with a hover card, status bar blame, file annotations (blame, heatmap, changes), CodeLens, and previous/next revision navigation.
- **Visual File History**: an interactive chart of a file's commits.
- **Interactive rebase editor** for `git-rebase-todo`.
- **Branch status bar**: worktree, branch, ahead/behind base branches, uncommitted count, and a protected-branch warning.
- **Optional AI helpers**, off by default and provider-agnostic: command-line tools, OpenAI-compatible APIs, the Anthropic API, or VS Code language models. API keys are kept in VS Code secret storage.
- An enable setting for every view and feature.
- Disabled in untrusted workspaces. Runs on the workspace side in remote setups.

[Unreleased]: https://github.com/prashanthviru/git-compass/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/prashanthviru/git-compass/releases/tag/v0.1.0
