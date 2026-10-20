# Security policy

## Supported versions

Security fixes go into the latest release. Please upgrade to the newest version from the [releases page](https://github.com/AAnkitpatel/k8sconsole/releases) before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). If that isn't possible, email **a.ankitpatel01@gmail.com** with "K8sConsole security" in the subject.

Please include the affected version, what an attacker could do, and steps to reproduce. You'll get an acknowledgement within 5 working days. We'll agree a disclosure date with you once a fix is available, and credit you in the release notes unless you prefer otherwise.

## Verify your download

Every release is built by the [Release workflow](https://github.com/AAnkitpatel/k8sconsole/actions/workflows/release.yml) on GitHub-hosted runners, and comes with:

- **Checksums:** `SHA256SUMS.txt`. Check with `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 <file>` (macOS) or `Get-FileHash <file>` (Windows).
- **Signed build provenance** ([SLSA](https://slsa.dev) attestations, signed through Sigstore). Proves a file was built from this repository by that workflow: `gh attestation verify <file> --repo AAnkitpatel/k8sconsole`
- **A software bill of materials:** `k8sconsole-<version>.cdx.json` (CycloneDX 1.5). Lists every third-party package that ships in the app, including Electron, with exact versions, licences and hashes. Feed it to a scanner such as `grype sbom:k8sconsole-<version>.cdx.json` or `trivy sbom k8sconsole-<version>.cdx.json`.

## How the project is protected

- **Code scanning:** CodeQL scans the TypeScript code and the workflows on every pull request and weekly.
- **Dependency review:** a pull request that adds a dependency with a known high or critical vulnerability fails.
- **Audit gate:** CI also fails if a shipped dependency has a high or critical advisory (`npm audit --omit=dev`).
- **Automated updates:** Dependabot opens updates for npm packages and GitHub Actions.
- **Secret scanning:** with push protection, pushes containing credentials are rejected.
- **Hardened workflows:** actions are pinned to commit SHAs, workflow tokens get the least permissions they need, and checkouts don't keep credentials.
- **Protected `main`:** changes need a reviewed pull request with passing checks on Linux, macOS and Windows.
- **Scorecard:** [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/AAnkitpatel/k8sconsole) rates these practices weekly.

## Scope

In scope: anything that lets K8sConsole leak credentials (kubeconfig, AWS, Claude API key), escape the renderer sandbox, bypass the IPC allow-list or input validation, make a change to a cluster or AWS account without the user's confirmation (including bypassing read-only mode), or send data to the AI assistant that should have been redacted.

Out of scope: vulnerabilities in Kubernetes, AWS or third-party services themselves, and issues that require an attacker who already controls the user's account or machine.

The security design is described in [docs/SECURITY.md](docs/SECURITY.md).
