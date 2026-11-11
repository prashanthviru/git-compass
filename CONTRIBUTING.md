# Contributing to Git Compass

Thanks for helping. This guide covers running the extension locally, the house style, and how releases happen.

## Getting started
1. Install [Git](https://git-scm.com), [Node.js](https://nodejs.org) 20 or newer, and VS Code 1.90 or newer.
2. Clone the repository and open it in VS Code:
   ```sh
   git clone https://github.com/prashanthviru/git-compass.git
   code git-compass
   ```
3. Press **F5**. A second VS Code window, the Extension Development Host, opens with your copy of Git Compass loaded. Open any Git repository in it to try your changes.
4. After editing code, run **Developer: Reload Window** in the development host to pick up the changes.

There is nothing to install: the extension has no runtime or build dependencies.

## Tests
```sh
npm test
```
This runs `node --test`. Tests use a small stand-in for the VS Code API (`tests/helpers/vscode.js`) and throwaway Git repositories in your temp folder (`tests/helpers/repo.js`), so they never touch your own repositories or the network. CI runs them on Linux, Windows and macOS.

To build an installable package:
```sh
npm run package
```
This runs `npx @vscode/vsce@3 package`. Install the resulting `.vsix` with **Extensions: Install from VSIX…**.

## Code style
- **No comments.** Make the code clear with good names and small functions. If a line truly needs explaining, one short comment is the limit. Background belongs in the pull request description.
- **No dependencies.** Use Node's built-ins and the VS Code API only.
- **CommonJS**, plain JavaScript, no build step.
- **Shell out safely.** Run `git`, `gh` and other tools with an argument array (`execFile`/`spawn`), never a shell string built from user input.
- **Respect settings.** Every user-visible feature has an enable setting, and an off feature does no work.
- Keep the 2-space indentation and the formatting from `.editorconfig`.

## Project layout
| File | Purpose |
|---|---|
| `extension.js` | Activation, branch status bar, loads the other modules |
| `git.js` | Running git, parsers, revision URIs, shared helpers |
| `views.js` | All side bar views and their commands, including Launchpad |
| `editor.js` | Blame, hovers, annotations, CodeLens, revision navigation |
| `visualHistory.js` | Visual File History webview |
| `rebase.js` | Interactive rebase custom editor |
| `ai.js`, `aiProviders.js` | AI commands and provider adapters |
| `package.json` | Commands, menus, views and settings |

## Adding a view
1. Add the view to `contributes.views` in `package.json` with `"when": "config.gitCompass.views.<name>.enabled"`.
2. Add the matching `gitCompass.views.<name>.enabled` setting under the **Views** configuration section.
3. In `views.js`, add its id to `VIEW`, write a root-children function, and create it in `register()` with `new View(context, '<name>', rootFn)`.
4. Add tests in `tests/views.test.js`.

## Adding a setting
1. Declare it in the right section of `contributes.configuration` with a clear description and default.
2. Read it with `config().get('<key>', <default>)` from `git.js`, and react to changes through `onDidChangeConfiguration`.
3. Document it in the README's Settings table.

## Pull requests
- Keep each pull request focused on one change, and describe what changed and why.
- Add or update tests, and make sure `npm test` passes.
- Update `CHANGELOG.md` under **Unreleased**.
- By contributing, you agree that your contribution is licensed under the MIT License.

## Releases
Every change that users will notice gets a line under **Unreleased** in `CHANGELOG.md`, grouped as Added, Changed, Fixed, Security or Performance. Those lines become the release notes.

To release, from an up-to-date `main` with a clean working tree:

```bash
npm run release -- patch --dry-run   # preview the version and notes
npm run release -- patch             # or minor, major, or an exact version like 1.0.0
```

This runs the tests, bumps `version` in `package.json`, moves the **Unreleased** notes under a dated version heading, commits, tags `vX.Y.Z` and pushes both.

The tag starts the **Release** workflow (`.github/workflows/release.yml`). It checks that the tag matches `package.json`, runs the tests, packages the extension, and then:
- publishes to the **VS Code Marketplace** with Trusted Publishing, so no token is stored. The policy for this repository and `release.yml` is set up on the publisher's Trusted Publishing page.
- publishes to **Open VSX** (Cursor, VSCodium, Windsurf) when the `OVSX_PAT` repository secret is set.
- creates a **GitHub Release** with that version's CHANGELOG section as its notes and the `.vsix` attached.

Re-running the workflow for the same tag is safe: versions that are already published are skipped.
