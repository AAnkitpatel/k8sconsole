# K8sConsole: Development

## Requirements

Node.js ≥ 22.12 (developed with 24.22) and npm 11. Linux also needs a C/C++ toolchain to build `node-pty` (`build-essential`, `python3`), plus `fakeroot` and `dpkg-deb` for the `.deb`. On macOS and Windows, node-pty's prebuilt binaries are used.

## Build and run

```bash
npm ci                                    # exact pinned versions
npm install-scripts approve esbuild node-pty && npm rebuild esbuild node-pty
node node_modules/electron/install.js     # downloads and verifies the Electron 43.7.7 binary
npm run build                             # main/preload (esbuild) + renderer (Vite) → build/out
env -u ELECTRON_RUN_AS_NODE npx electron .   # run the dev build
npm run package:deb                       # Linux → dist/k8sconsole_<version>_amd64.deb
node build/scripts/package.mjs            # macOS → .dmg/.zip (arm64 + x64); Windows → installer + .zip (x64)
```

Installers are built on the operating system they target; the *Release* workflow does this on GitHub-hosted Linux, macOS and Windows runners and tests each installer before publishing. `build/scripts/stage-app.mjs` prepares the app archive and the platform's `node-pty` binaries for both packaging paths. node-pty ships in `resources/node-pty`, outside `app.asar`, so its helper programs (macOS `spawn-helper`, Windows ConPTY) are real files.

`package:deb` bundles the app into `app.asar` (the native `node-pty` binary is unpacked next to it), hardens the Electron fuses, regenerates `THIRD_PARTY_NOTICES.txt`, and builds the package with `fakeroot dpkg-deb`. The icon set is generated with `python3 -I build/scripts/make-icon.py build/assets`.

## Layout

```
build/app/src/shared     IPC contract, resource catalog, graph/security/RBAC/timeline engines, formatting, validation
build/app/src/main       Electron main process: controller, Kubernetes access, terminal, monitor, Helm, AI assistant
build/app/src/main/aws   Amazon ECS: credentials and read-only guard, ECS/CloudWatch/ELB/EC2 calls, log tailing, assistant tools
build/app/src/renderer/ecs  ECS workspace views
build/app/src/preload    contextBridge API (window.k8sc)
build/app/src/renderer   React UI: views, components, styles
build/app/resources      shell bootstrap resources (bundled zsh-autosuggestions)
build/scripts            build, packaging, fuses, licence collection, icon generation
tests/                   unit, integration, e2e, package validation, fixtures, disposable-cluster scripts
website/                 static launch site
docs/                    architecture, security model, this file
```

## Tests

```bash
npm run typecheck && npm run lint
npm test                                  # unit tests (no cluster, no network)

# Disposable cluster (k3s in Docker). NEVER point the tests at a real cluster.
bash tests/cluster/start-k3s.sh
export K8SC_TEST_KUBECONFIG=$PWD/work/k3s/kubeconfig.yaml
export K8SC_TEST_HELM=/path/to/helm       # optional: Helm tests
npm run test:integration
K8SC_TEST_RESTART_CONTAINER=k8sc-test-k3s npm run test:recovery
xvfb-run -a node tests/e2e/smoke.mjs      # UI test of the dev build (the assistant talks to a local mock)
bash tests/cluster/stop-k3s.sh
```

### Amazon ECS

```bash
xvfb-run -a node tests/e2e/ecs.mjs        # UI test against a local AWS stand-in (tests/e2e/mock-aws.mjs); no AWS account

# Optional, against a real AWS account. Read-only: only describes and lists.
K8SC_AWS_PROFILE=<profile> K8SC_AWS_REGION=<region> npx vitest run --config build/app/vitest.config.ts --project integration tests/integration/ecs-aws.test.ts

# Optional write test: creates, scales, stops and deletes its own k8sconsole-selftest-* resources in ONE cluster you
# approve, and fails if any other service in that cluster changed. Never point it at a cluster you are not allowed to change.
K8SC_AWS_WRITE_CLUSTER=<cluster ARN> K8SC_AWS_WRITE_CONFIRM=create-and-delete-selftest-resources K8SC_AWS_PROFILE=<profile> \
  npx vitest run --config build/app/vitest.config.ts --project integration tests/integration/ecs-aws.test.ts -t writes
```

The AWS SDK honours `AWS_ENDPOINT_URL`, which is how the UI test reaches the local stand-in.

The AI assistant tests never call the real Claude API: they run the real SDK against a local mock of the Messages API (`tests/unit/mock-claude.ts`). Tests redirect `HOME`, the Helm configuration and the app data folder to temporary directories.

If the test node never becomes Ready (`too many open files` in `docker logs`), raise the inotify limit temporarily: `sudo sysctl -w fs.inotify.max_user_instances=512` (revert with `=128`).

## Package validation

```bash
docker run --rm --network host -v $PWD/dist:/pkg:ro -v $PWD:/src:ro \
  -v "$(dirname "$(dirname "$(which node)")")":/node:ro -v "$(which kubectl)":/usr/local/bin/kubectl:ro \
  -e K8SC_TEST_KUBECONFIG=/src/work/k3s/kubeconfig.yaml ubuntu:24.04 bash /src/tests/package/validate-deb.sh
```
