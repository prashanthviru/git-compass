# Security Policy

## Reporting a vulnerability
Please **do not open a public issue** for security problems.

Report them privately through [GitHub Security Advisories](https://github.com/prashanthviru/git-compass/security/advisories/new). Include what you found, how to reproduce it, and the impact you expect. You should get a reply within a week. Once a fix is released, the report can be made public, with credit to you if you'd like it.

## Supported versions
Security fixes go into the latest released version.

## What's in scope
- **Running Git and other tools.** Git Compass runs `git`, the GitHub CLI and, if you configure one, an AI command-line tool, always with argument arrays and no shell. Git can run programs configured by a repository, so Git Compass is disabled in untrusted (Restricted Mode) workspaces. A way to make it run commands in an untrusted workspace, or to inject arguments or shell syntax, is in scope.
- **AI data flow.** AI features are off by default. When enabled, they send diffs, commit messages and pull request text only to the provider you configured, and only when you run an AI command. Sending data anywhere else, or without an AI command being run, is in scope.
- **Secrets.** API keys are kept in VS Code's secret storage and never written to settings. Leaking a key into settings, logs, output, or a request to any host other than the configured provider is in scope.
- **Webviews.** The Visual File History and rebase editor webviews use a strict content security policy. Script injection through commit messages, author names, file names or rebase todo content is in scope.

## Out of scope
- Problems in Git, the GitHub CLI, VS Code, or a third-party AI provider or CLI itself.
- Data you send yourself by choosing and running an AI provider.
