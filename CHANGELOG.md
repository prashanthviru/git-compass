# Changelog

All notable changes to Git Compass are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Git identities.** Switch who you commit as from the status bar or **Git Compass: Switch Git Identity…**:
  - Every GitHub account already signed in to the GitHub CLI is listed, ready to use: pick one, choose which email to commit with, and Git Compass saves it as an identity.
  - Each identity has a name and email, and optionally a GitHub CLI account and an SSH key.
  - Switching sets `user.name` and `user.email` for this repository (or globally). It also sets the repository's SSH key and switches `gh` to that GitHub account, so pushes and pull requests use the right one.
  - Rules such as `github.com/my-company/` warn when a repository commits as the wrong person and offer to fix it.
  - **Sign in to another GitHub account** starts `gh auth login` in a terminal. No passwords or tokens are stored.
  - The GitHub CLI has one active account per host, so switching the GitHub account applies to every repository that pushes over HTTPS. SSH keys are set per repository.

### Changed
- The branch status bar item now explains itself in plain words, such as "feature/x · 3 commits ahead of main", "Editing main directly · 6 changes" or "main is up to date".
  - It turns amber only when something needs attention: uncommitted or unpushed work on a protected branch, or not being on a branch.
  - Its hover explains why and offers the next step: move changes to a new branch, update from main, create a pull request, or pull.
  - Clicking it puts those suggestions first.
  - The worktree name only appears when you have more than one worktree.

### Security
- Identities are read only from your user settings (`gitCompass.identities`); a repository's `.vscode/settings.json` cannot add or change them.

## [1.0.0] - 2026-11-12

### Changed
- Git Compass is out of preview. This is the first stable release, available on the VS Code Marketplace and on Open VSX for Cursor, VSCodium and Windsurf.

## [0.2.3] - 2026-11-11

### Changed
- Current-line blame moves with the cursor without flickering: once a file's blame is loaded, the new line is drawn immediately instead of being cleared and redrawn.
- Softer current-line blame colour that suits light, dark and high-contrast themes, with long commit messages shortened. Change the colour with `gitCompass.currentLineBlame.foreground` in `workbench.colorCustomizations`.
- New `gitCompass.currentLine.format` setting, for example `${author}, ${ago} • ${message}` or `${sha} ${message}`.
- Clearer blame hover card: author and date, the commit message in bold, then the SHA, size and refs, with icon buttons for Open Changes, Previous Revision, Show Commit and Copy SHA.
- Modern side bar:
  - Commits show an icon and colour for their type (feat, fix, perf, refactor, docs, test, ci, build, chore, release, revert), merge commits in purple and unpushed commits in yellow, with a short age ("28m", "3d") and any tags.
  - The current branch is green. Branches whose names share a prefix (`dependabot/…`, `feature/…`) are grouped in a folder.
  - Remotes show a GitHub icon and `owner/repo` instead of the full URL.
  - Tags and stashes have colour and a count.
  - Remotes, Stashes, Tags and Worktrees start collapsed, so the side bar opens on Commits and Branches.
- New Git Compass activity bar icon: a compass needle that stays clear at small sizes and is easy to tell apart from VS Code's Source Control icon.

- Redesigned Visual File History:
  - Summary cards for commits, authors, lines changed and last change.
  - An activity chart fitted to the file's real date range. Click a bar to see only those commits.
  - A calendar heat map: one square per day, darker on days with more changes. Hover for the day's totals, and click a day to list its commits. It always ends at today and shows as many weeks as fit the panel.
  - Author chips with initials; click one to filter.
  - A commit list grouped by day, with the SHA, age and a small added/removed bar. Click a commit to open its diff, or use "Commit" to see the whole commit.
  - Works in narrow side panels, and long histories load 60 commits at a time.

### Fixed
- Visual File History says "1 commit by 1 author" instead of "1 commits".

### Security
- Links in hover cards can only run the commands shown on that card.

## [0.2.1] - 2026-11-11

### Security
- AI settings that decide where code is sent or what runs (`ai.provider`, `ai.cli.*`, the API base URLs and `ai.apiKeyEnvVar`) can no longer be set by a repository's workspace settings. Set them in user or remote settings.
- A saved Anthropic API key is only sent to the server it was saved for.
- Branch, tag and pull request names taken from a repository or remote can no longer be read as git options.
- Start Review recognises pull requests from forks and fetches them safely.
- On Windows, command-line AI tools refuse arguments that `cmd.exe` cannot pass safely.
- Remote images in AI answers are shown as links, so opening an answer cannot send data to another server.

### Fixed
- Git Compass no longer fails to start when Git is not installed or the Git extension is turned off; it explains what to do instead.
- Uses the Git that VS Code found (including `git.path`), not only the one on `PATH`.
- File names with accents, CJK characters or emoji open correctly.
- Expanding a commit works with Git 2.30.
- Force Delete Branch is offered in every language.
- Fetch and push fall back to VS Code's sign-in when credentials are needed, for example in Remote SSH and WSL.
- AI conflict resolutions keep the file's Windows line endings, and Windows command-line AI output is parsed correctly.
- Change markers and the commit view work when a custom diff tool or forced colour is configured.

### Performance
- Blame and file history are only recomputed when a commit changes, not on every save.
- CodeLens no longer re-blames the whole file while you type.
- Switching editors no longer loads a file's full history or runs `git status`.
- Ahead/behind counts in the status bar are cached.
- Background git commands no longer take the index lock, so they cannot block your own commits.
- Launchpad skips polling while the window is in the background.

## [0.2.0] - 2026-11-11

First Marketplace release.

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

[Unreleased]: https://github.com/prashanthviru/git-compass/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/prashanthviru/git-compass/compare/v0.2.3...v1.0.0
[0.2.3]: https://github.com/prashanthviru/git-compass/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/prashanthviru/git-compass/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/prashanthviru/git-compass/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/prashanthviru/git-compass/releases/tag/v0.1.0
