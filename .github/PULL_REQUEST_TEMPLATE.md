## What does this change?

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## How was it tested?

- [ ] `npm run typecheck` and `npm run lint`
- [ ] `npm test` (added or updated unit tests)
- [ ] UI checked (`xvfb-run -a node tests/e2e/ecs.mjs`, and/or the Kubernetes smoke test on the disposable k3s cluster)

## Checklist

- [ ] The PR title follows conventional commits (`feat:`, `fix:`, `docs:` …)
- [ ] Docs and `CHANGELOG.md` ("Unreleased") updated if behaviour changed
- [ ] No secrets, kubeconfigs, AWS account IDs or real cluster names in code, tests or screenshots
- [ ] Changes to clusters still ask for confirmation; read-only mode and the IPC allow-list are respected

## Screenshots

<!-- For UI changes: before / after. -->
