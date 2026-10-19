# Contributing to K8sConsole

Thanks for helping! K8sConsole is an agent-free desktop console for Kubernetes and Amazon ECS. Bug reports, fixes, features, docs and tests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security problems privately: see [SECURITY.md](SECURITY.md), not public issues.

## Ways to contribute

- **Report a bug:** open an issue with the *Bug report* form. Include the version (Help → About), your OS and desktop (X11 or Wayland), and the steps to reproduce.
- **Suggest a feature:** open a *Feature request* first, so we can agree on the approach before you write code.
- **Pick up work:** issues labelled `good first issue` and `help wanted` are ready to take. Comment on the issue so nobody duplicates the work.

## Development setup

Requirements: Linux x86-64, Node.js 22.12 or newer (CI uses Node 24), npm 11, a C/C++ toolchain for `node-pty` (`build-essential`, `python3`), and for packaging `fakeroot` and `dpkg-deb`.

```bash
git clone https://github.com/AAnkitpatel/k8sconsole.git && cd k8sconsole
npm ci
node node_modules/electron/install.js        # downloads the pinned Electron binary
npm run build
npx electron .                               # run the app from source
```

More detail, including the layout of the code, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Before you open a pull request

Run the same checks CI runs:

```bash
npm run typecheck
npm run lint
npm test                                     # unit tests: no cluster, no network
npm run build
xvfb-run -a node tests/e2e/ecs.mjs           # ECS UI test against a local AWS stand-in
```

If you change Kubernetes behaviour, also run the integration and UI tests against the **disposable** k3s cluster described in `docs/DEVELOPMENT.md`. Never point tests at a real or shared cluster or AWS account.

## Pull request rules

1. **One change per pull request.** Keep it focused; split refactors from features.
2. **Branch from `main`** and name the branch after the change, e.g. `fix/ecs-log-tail` or `feat/helm-diff`.
3. **Tests are required** for bug fixes (a test that fails without the fix) and for new behaviour.
4. **CI must pass**: type check, lint, unit tests, build and the ECS UI test. A maintainer review is required before merging; `main` is protected.
5. **Conventional commit messages** in the PR title, which becomes the squash-merge commit: `feat: …`, `fix: …`, `docs: …`, `test: …`, `refactor: …`, `chore: …`, `ci: …`.
6. **Update docs** (README, docs/, CHANGELOG.md "Unreleased") when behaviour or settings change.
7. **Dependencies** are pinned to exact versions. Explain why in the PR when you add or upgrade one, and keep `npm audit` clean.
8. **No secrets or real infrastructure identifiers** in code, tests or screenshots: no access keys, tokens, kubeconfigs, account IDs or cluster names. Tests use AWS's documentation example accounts (`123456789012`, `111122223333`).

## Project rules that protect users

These are deliberate design decisions. Changes to them need an issue and maintainer agreement first.

- **Credentials never reach the UI.** Kubernetes and AWS access happens only in the main process; the renderer is sandboxed with `connect-src 'none'`.
- **Every IPC method is allow-listed** in `build/app/src/shared/api.ts` and validates its input in the main process.
- **Changes to clusters always ask first.** Destructive actions require typing the name. AWS connections are read-only by default, enforced in the SDK middleware.
- **The AI assistant is read-only.** It may only propose changes for the user to review; secret and environment values are never sent to it.
- **No telemetry** and no network calls the user didn't ask for.

## Code style

TypeScript strict mode, React function components and hooks, and the existing naming and comment style. ESLint and the type checker are the source of truth. Prefer small, pure, unit-tested functions in `build/app/src/shared` for logic.

## Releases (maintainers)

1. Update `version` in `package.json` and move "Unreleased" notes in `CHANGELOG.md` under the new version.
2. Merge to `main`, then tag: `git tag -a v1.2.0 -m "K8sConsole 1.2.0" && git push origin v1.2.0`.
3. The *Release* workflow builds the `.deb`, writes its SHA-256, and publishes a GitHub release with both files.
4. Update the download version and checksum in `website/index.html`; the *Website* workflow deploys it.

## Licence

K8sConsole is released under the [MIT Licence](LICENSE). By contributing you agree that your contributions are licensed under the same terms.
