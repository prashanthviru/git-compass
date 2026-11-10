# Git Compass

Find your way around any Git repository from inside VS Code. You get blame, file and line history, a visual history chart, worktrees, branch compare, an interactive rebase editor, a pull request Launchpad and optional AI helpers. Everything is free and works on public and private repositories, with no account or sign-up.

> **Preview.** Git Compass is at 0.1.0 and still being tested. Please [report anything that breaks](https://github.com/prashanthviru/git-compass/issues).

## Install

Git Compass isn't on the Marketplace yet. Until it is, install it from a `.vsix` file. You need VS Code 1.90 or newer, or VSCodium.

### 1. Get the `.vsix` file

Choose one:

- **Download a build.** Open the [CI workflow runs](https://github.com/prashanthviru/git-compass/actions/workflows/ci.yml), choose the latest successful run on `main`, and download the **git-compass-vsix** artifact. You must be signed in to GitHub to download it. Unzip it to get `git-compass.vsix`.
- **Build it yourself.** You need Git and Node.js 20 or newer:

  ```bash
  git clone https://github.com/prashanthviru/git-compass.git
  cd git-compass
  npm run package
  ```

  This creates `git-compass.vsix` in the folder.

### 2. Install it in VS Code

- **From the Extensions view:** press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS), open the **…** menu at the top of the view, choose **Install from VSIX…**, and pick `git-compass.vsix`.
- **From a terminal:**

  ```bash
  code --install-extension git-compass.vsix
  ```

  In VSCodium, use `codium --install-extension git-compass.vsix`.

Then reload the window: open the Command Palette and run **Developer: Reload Window**. Two icons appear in the activity bar: **Git Compass** and **Git Compass Inspect**.

### 3. First steps

- Open a folder that is a Git repository and trust it when VS Code asks. Git Compass stays off in Restricted Mode.
- For **Launchpad**, install the [GitHub CLI](https://cli.github.com) and run `gh auth login`.
- AI stays off until you run **Git Compass: Set Up AI Provider…** from the Command Palette.
- If another installed extension also shows blame or opens rebase files, turn off that feature in one of them so you don't see it twice.

### Update or uninstall

- **Update:** install the newer `.vsix` the same way. It replaces the old version.
- **Uninstall:** open the Extensions view, select Git Compass and choose **Uninstall**, or run `code --uninstall-extension prashanthviru.git-compass`.

## Screenshots

Screenshots and short clips are coming with the first Marketplace release.

## Features

### Git Compass side bar
| View | What it shows |
|---|---|
| **Commits** | The current branch's commits, with unpushed ones highlighted. Expand a commit to see its files and open any diff. |
| **Branches** | Local branches with ahead/behind counts against their upstream. Switch, compare, copy the name or delete. |
| **Remotes** | Each remote and its branches. |
| **Stashes** | Your stashes and their files. Apply, pop or drop. |
| **Tags** | Tags and their commits. Compare a tag with your branch, or delete it. |
| **Worktrees** | Every worktree, with ahead/behind and uncommitted counts. Create, open in a new window or this one, reveal or remove. |
| **Launchpad** | Your open pull requests grouped as Needs Your Review, Blocked, Ready to Merge, Waiting for Review, Assigned to You and Drafts. Pin, snooze, merge, check out, or open in a new worktree. Needs the GitHub CLI. |

### Git Compass Inspect side bar
| View | What it shows |
|---|---|
| **File History** | Follows the active file, uncommitted changes included. Click a commit to see what it changed in that file. |
| **Line History** | Commits that touched the line or selection under your cursor. |
| **Compare** | Your branch, including uncommitted changes, against any branch or tag, as Behind, Ahead and Files Changed. |
| **Search Commits** | Search by message, author, file, code added or removed, regex, or SHA. |

### In the editor
- **Current-line blame** at the end of the line, with a hover card that links to the changes, the previous revision and the full commit, and can copy the SHA.
- **Status bar blame** for the current line.
- **File annotations**: full-file blame in the gutter, a heatmap of how recent each line is, or highlights for lines changed since the last commit.
- **CodeLens** above functions and classes, showing who changed them last and how many people have.
- **Revision navigation**: step a file back and forward through its history.
- **Visual File History**: an interactive timeline of a file's commits by author and size.
- **Interactive rebase editor**: reorder commits by dragging, pick an action for each, then start or abort.
- **Branch status bar**: worktree, branch, ahead/behind your base branches, and uncommitted count. Turns amber on protected branches.

### AI helpers (optional, off by default)
Write commit messages, stash messages, changelogs and pull request descriptions. Explain or review a commit, your changes, a branch or a pull request. Search history in plain language, and start work from an issue or start a review from a pull request.

You choose the AI provider and configure it yourself. Run **Git Compass: Set Up AI Provider…**:

| Provider type | Examples | Credentials |
|---|---|---|
| Command-line tool | Claude Code, Codex, Gemini CLI, or any CLI that reads a prompt and prints an answer | Whatever the tool already uses |
| OpenAI-compatible API | OpenAI, OpenRouter, Ollama, LM Studio, or any compatible endpoint | API key in VS Code's secret storage, or none for local servers |
| Anthropic API | Claude models | API key in VS Code's secret storage |
| VS Code language models | Models provided by another installed extension | Handled by VS Code |

API keys are stored in VS Code's secret storage, never in settings files. You can also point Git Compass at an environment variable with `gitCompass.ai.apiKeyEnvVar`.

## Requirements
- Git 2.30 or newer on your `PATH`.
- Optional: the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, for Launchpad, Start Work and Start Review.
- Optional: an AI provider from the table above.

Git Compass works in VS Code 1.90+ and in VSCodium and other editors that install from Open VSX. In Remote SSH, WSL, Dev Containers and Codespaces it runs on the remote side, next to your repository. It is turned off in untrusted (Restricted Mode) workspaces, because Git can run programs configured by a repository, and it does not support virtual workspaces.

## Commands
Open the Command Palette and type **Git Compass**:

| Area | Commands |
|---|---|
| History | Show File History, Show Line History, Open Visual File History, Open Previous / Next Revision |
| Compare and search | Compare Branch with…, Compare File with Branch…, Search Commits… |
| Worktrees | Show Worktrees, Create Worktree… |
| Annotations | Toggle File Blame, Toggle File Heatmap, Toggle File Changes, Clear File Annotations |
| Rebase | Open Rebase Todo as Text |
| AI | Set Up AI Provider…, Set AI API Key, Clear AI API Key, Test AI Connection, Generate Commit Message, Stash with AI Message…, Generate Changelog…, Generate Pull Request…, Explain Commit, Explain Changes, Review with AI, AI Search Commits…, Start Work on Issue…, Start Review of Pull Request… |
| General | Menu, Refresh |

Most actions are also on right-click menus and inline buttons in the views.

## Keyboard shortcuts
| Shortcut | Action |
|---|---|
| `Ctrl+Alt+H` | Show File History |
| `Ctrl+Alt+L` | Show Line History (editor focused) |
| `Ctrl+Alt+W` | Show Worktrees |
| `Ctrl+Alt+B` | Toggle File Blame (editor focused) |
| `Alt+,` / `Alt+.` | Previous / next revision of the file |

On macOS, use `Ctrl+Option` in place of `Ctrl+Alt`. You can change any shortcut in **Keyboard Shortcuts**.

## Settings
Every part of Git Compass can be turned off.

| Setting | Default | Controls |
|---|---|---|
| `gitCompass.views.<view>.enabled` | `true` | Each view: `commits`, `branches`, `remotes`, `stashes`, `tags`, `worktrees`, `launchpad`, `fileHistory`, `lineHistory`, `compare`, `search` |
| `gitCompass.currentLine.enabled` | `true` | Current-line blame and its hover |
| `gitCompass.statusBarBlame.enabled` | `true` | Blame in the status bar |
| `gitCompass.codeLens.enabled` | `true` | CodeLens above symbols |
| `gitCompass.fileAnnotations.enabled` | `true` | File blame, heatmap and changes |
| `gitCompass.revisionNavigation.enabled` | `true` | Previous/next revision buttons |
| `gitCompass.visualHistory.enabled` | `true` | Visual File History |
| `gitCompass.rebaseEditor.enabled` | `true` | Interactive rebase editor; when off, rebase todos open as text |
| `gitCompass.statusBar.branch.enabled` | `true` | Branch status bar |
| `gitCompass.baseBranches` | `[]` | Branches for ahead/behind and compare, e.g. `["develop", "main"]`. Empty uses the remote's default branch |
| `gitCompass.protectedBranches` | `main`, `master`, … | Branches that turn the status bar amber |
| `gitCompass.launchpad.statusBar.enabled` | `true` | Launchpad counts in the status bar |
| `gitCompass.ai.provider` | `none` | `none`, `cli`, `openaiCompatible`, `anthropic` or `vscodeLm` |
| `gitCompass.ai.cli.command` / `.args` / `.promptInput` | | The command-line tool to run and how it receives the prompt |
| `gitCompass.ai.openaiCompatible.baseUrl` / `.model` | | Endpoint and model for OpenAI-compatible APIs |
| `gitCompass.ai.anthropic.baseUrl` / `.model` | | Endpoint and model for the Anthropic API |
| `gitCompass.ai.vscodeLm.vendor` / `.family` | | Which VS Code language model to use |
| `gitCompass.ai.apiKeyEnvVar` | | Read the API key from this environment variable instead |
| `gitCompass.ai.maxContextChars` | `120000` | Largest diff or history sent in one request |
| `gitCompass.ai.timeoutSeconds` | `180` | How long to wait for an answer |

## Privacy
- Git Compass collects **no telemetry** and has no server of its own.
- Git commands run locally on your machine, or on the remote side in a remote workspace.
- Launchpad talks to GitHub only through your own GitHub CLI.
- AI features are off until you choose a provider. When you run an AI command, the diff, commit messages or pull request text it needs are sent only to that provider. The first time, Git Compass tells you where the data is going.

## Contributing
Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/prashanthviru/git-compass/blob/main/CONTRIBUTING.md). Please report security problems privately, as described in [SECURITY.md](https://github.com/prashanthviru/git-compass/blob/main/SECURITY.md).

## License
[MIT](https://github.com/prashanthviru/git-compass/blob/main/LICENSE). "Git" is a trademark of the Software Freedom Conservancy; this project is not affiliated with or endorsed by it.
