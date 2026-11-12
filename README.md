# Git Compass

Find your way around any Git repository from inside VS Code. You get blame, file and line history, a visual history chart, worktrees, branch compare, an interactive rebase editor, a pull request Launchpad and optional AI helpers. Everything is free and works on public and private repositories, with no account or sign-up.

Found a bug or have an idea? [Open an issue](https://github.com/prashanthviru/git-compass/issues).

## Install

You need VS Code 1.90 or newer, or an editor based on it.

- **VS Code:** press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS), search for **Git Compass**, and choose **Install**. It is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Prashanthviru.git-compass).
- **Cursor, VSCodium, Windsurf and other VS Code-based editors:** search for **Git Compass** in their Extensions view. It is on [Open VSX](https://open-vsx.org/extension/Prashanthviru/git-compass).
- **From a terminal:**

  ```bash
  code --install-extension Prashanthviru.git-compass
  ```

  Use `cursor` or `codium` instead of `code` for those editors.

Two icons appear in the activity bar: **Git Compass** and **Git Compass Inspect**.

### Install from a `.vsix` file

Use this to try a build from `main` before it is released. Download the **git-compass-vsix** artifact from the latest successful [CI workflow run](https://github.com/prashanthviru/git-compass/actions/workflows/ci.yml) (you must be signed in to GitHub), or build it yourself with Git and Node.js 20 or newer:

```bash
git clone https://github.com/prashanthviru/git-compass.git
cd git-compass
npm run package
```

Then, in the Extensions view, open the **…** menu, choose **Install from VSIX…** and pick `git-compass.vsix`. In VSCodium you can also run `codium --install-extension git-compass.vsix`.

### 3. First steps

- Open a folder that is a Git repository and trust it when VS Code asks. Git Compass stays off in Restricted Mode.
- For **Launchpad**, install the [GitHub CLI](https://cli.github.com) and run `gh auth login`.
- AI stays off until you run **Git Compass: Set Up AI Provider…** from the Command Palette.
- If another installed extension also shows blame or opens rebase files, turn off that feature in one of them so you don't see it twice.

### Update or uninstall

- **Update:** VS Code updates Marketplace installs automatically. For a `.vsix`, install the newer file the same way.
- **Uninstall:** open the Extensions view, select Git Compass and choose **Uninstall**, or run `code --uninstall-extension Prashanthviru.git-compass`.

## Screenshots

Screenshots and short clips are coming soon.

## Features

### Git Compass side bar
| View | What it shows |
|---|---|
| **Conflicts** | Appears only while a merge, rebase, cherry-pick or revert has conflicts. Shows what is happening ("Rebasing feature onto main (2/5)"), each conflicted file with which side changed what, and the files already resolved. Open the merge editor, accept the current or incoming side, mark files resolved, ask AI for a suggested resolution, then Continue, Skip or Abort. |
| **Commits** | The current branch's commits, with unpushed ones highlighted. Expand a commit to see its files and open any diff. |
| **Branches** | Local branches with ahead/behind counts against their upstream. Switch, compare, merge into the current branch (merge commit, fast-forward only or squash), rebase onto, update from the base branch, create a pull request, copy the name or delete. |
| **Remotes** | Each remote and its branches. |
| **Stashes** | Your stashes and their files. Apply, pop or drop. |
| **Tags** | Tags and their commits. Compare a tag with your branch, or delete it. |
| **Worktrees** | Every worktree, with ahead/behind and uncommitted counts. Create, open in a new window or this one, reveal or remove. |
| **Launchpad** | Your open pull requests grouped as Needs Your Review, Blocked, Ready to Merge, Waiting for Review, Assigned to You and Drafts. Create a pull request, merge any pull request (squash, merge commit, rebase or auto-merge when checks pass, with warnings for failing checks, missing approval, conflicts or drafts), resolve a pull request's conflicts locally, pin, snooze, check out, or open in a new worktree. Needs the GitHub CLI. |

### Pull requests, merging and conflicts
- **Create Pull Request** opens a form in VS Code: pick the base branch, edit the title and description (prefilled from your repository's pull request template or your commits), add reviewers and labels, choose draft, or let AI write it. If the branch isn't on origin yet, Git Compass offers to push it first.
- **Merge** a pull request from Launchpad, or merge or rebase branches locally from the Branches view.
- **Resolve conflicts** in the Conflicts view, including conflicts on a pull request: Git Compass checks the branch out, merges the base in, and lets you push the result when you're done.
- Anything that changes GitHub or your remote asks you to confirm first. Git Compass pushes only with an explicit branch name, never force-pushes, and refuses to push protected branches.

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
- **Branch status bar**: says where you are in plain words ("feature/x · 3 commits ahead of main", "Editing main directly · 6 changes") and turns amber only when something needs attention. Hover or click it for the next step: move changes to a branch, update from main, pull, or create a pull request.

### Git identities
Keep personal and work commits apart, and push with the right GitHub account.
- **Status bar**: shows who you commit as in this repository. It turns amber when the repository's rule expects someone else. Click it to switch.
- **Signed-in accounts**: every GitHub account you are already signed in to with the GitHub CLI is listed, so you can switch to it without typing anything.
- **Identities**: each has a name and email, and optionally a GitHub CLI account (switched with `gh auth switch`, so pushes and pull requests use it) and an SSH key (set for that repository only).
- **Rules**: tie an identity to remotes such as `github.com/my-company/`. Git Compass offers to switch when a matching repository commits as someone else.
- **Sign in to another GitHub account** from the same menu. Sign-in itself happens in `gh`; Git Compass never stores passwords or tokens.

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

The settings that choose where your code is sent (provider, command-line tool and arguments, API base URLs and `apiKeyEnvVar`) are read only from your user or remote settings. A repository's `.vscode/settings.json` cannot change them.

## Requirements
- Git 2.30 or newer. Git Compass uses the same Git as VS Code, including the `git.path` setting.
- Optional: the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, for Launchpad, Start Work and Start Review.
- Optional: an AI provider from the table above.

Git Compass works in VS Code 1.90+ and in VSCodium and other editors that install from Open VSX. In Remote SSH, WSL, Dev Containers and Codespaces it runs on the remote side, next to your repository, so the GitHub CLI, AI command-line tools and local AI servers such as Ollama must be available on that remote machine. It is turned off in untrusted (Restricted Mode) workspaces, because Git can run programs configured by a repository, and it does not support virtual workspaces.

## Commands
Open the Command Palette and type **Git Compass**:

| Area | Commands |
|---|---|
| Identity | Switch Git Identity…, Add Git Identity…
| History | Show File History, Show Line History, Open Visual File History, Open Previous / Next Revision |
| Compare and search | Compare Branch with…, Compare File with Branch…, Search Commits… |
| Worktrees | Show Worktrees, Create Worktree… |
| Pull requests and merging | Create Pull Request…, Push Current Branch, Update Current Branch from Base |
| Conflicts | Continue Merge or Rebase, Skip Commit, Abort Merge or Rebase |
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
| `gitCompass.views.<view>.enabled` | `true` | Each view: `conflicts`, `commits`, `branches`, `remotes`, `stashes`, `tags`, `worktrees`, `launchpad`, `fileHistory`, `lineHistory`, `compare`, `search` |
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
| `gitCompass.pr.defaultDraft` | `false` | Tick "Create as draft" by default in the Create Pull Request form |
| `gitCompass.pr.deleteBranchAfterMerge` | `false` | Offer deleting the branch first when merging a pull request |
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
