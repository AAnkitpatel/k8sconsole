# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.4.0] - 2026-10-30

### Added
- **GitOps.** Flux (Kustomizations, HelmReleases, Git/OCI/Helm sources, image automation) and Argo CD (Applications, ApplicationSets) with sync, health, source, revision and errors. Actions, each confirmed: reconcile, suspend and resume (Flux); refresh, hard refresh and sync (Argo CD).
- **Cost monitoring.**
  - **Kubernetes:** estimated monthly cost by namespace and workload, from requests and live usage. It also shows idle (requested but unused) cost, unallocated cluster capacity, and rightsizing recommendations from peak usage.
  - **Amazon ECS:** Fargate cost per service, with a smaller valid task size suggested from 24-hour utilization.
  - **Rates:** editable in the Cost view.
- **Image vulnerability scanning** for images running in Kubernetes and in ECS task definitions. Reads Trivy Operator reports from the cluster (agent-free for the app) or scans with a local `trivy`, with ECR images authenticated through the app's AWS connection. Shows severity counts, fixable vulnerabilities and the workloads affected.
- **Built-in MCP server**, off by default. Claude Code, Claude Desktop, Cursor and other MCP clients can use K8sConsole's read-only tools against the connected cluster and AWS account. It listens on 127.0.0.1 only, needs a bearer token, rejects browser origins, and lists recent calls in Settings.
- **Extensions:** declarative JSON add-ons that add terminal commands (typed in, never run automatically), links and policy rules. No third-party code runs inside the app.
- **Hotbar:** pin clusters for one-click switching (Alt+1…9).
- AI assistant tools for GitOps, cost and image vulnerabilities.

## [1.3.0] - 2026-10-20

### Added
- **Built-in ECS Exec.** Container shells connect directly through ECS `ExecuteCommand` and the Session Manager protocol, so the aws CLI and Session Manager plugin are no longer needed. This also works with IAM roles assumed in the app. Tested live against Fargate.

### Changed
- macOS builds use the hardened runtime, and the Release workflow signs with a Developer ID and notarizes as soon as the signing secrets are configured (see `docs/MACOS-SIGNING.md`).
- Clearer first-launch instructions for macOS 15, where right-click → Open no longer bypasses Gatekeeper.

## [1.2.1] - 2026-10-20

### Fixed
- Object names `.` and `..` are rejected when building Kubernetes API paths. Before, they could address the parent API path instead of an object. Found by fuzz testing.
- The YAML validator (editor, apply, assistant proposals) reports documents with an alias to a missing anchor as invalid YAML instead of throwing. Found by fuzz testing.

### Security
- Releases include signed build provenance (SLSA, verifiable with `gh attestation verify`) and a CycloneDX SBOM of everything that ships.
- Property-based fuzz tests (fast-check) for API path building, the `app://` protocol, the AWS read-only guard, settings and connection input, terminal suggestions and manifest validation.
- CodeQL code scanning, dependency review on pull requests, a production `npm audit` gate, OpenSSF Scorecard, secret-scanning push protection, and workflow hardening (SHA-pinned actions, least-privilege tokens, no persisted credentials).

## [1.2.0] - 2026-10-20

### Added
- **macOS** builds for Apple Silicon and Intel (`.dmg` and `.zip`) and **Windows** x64 builds (installer and portable `.zip`), alongside the Linux `.deb`.
- Windows terminal support: PowerShell 7, Windows PowerShell or `cmd.exe`, plus Git Bash when chosen. Tools such as `kubectl`, `helm`, `aws` and the Session Manager plugin are found through `PATHEXT`.
- macOS application and window menus.

### Changed
- The terminal's native module now ships next to the app archive (`resources/node-pty`) on every platform.

## [1.1.0] - 2026-10-19

### Added
- **Amazon ECS workspace.**
  - **Connecting:** AWS profiles (access keys, SSO, role profiles, credential process) or the default credential chain (environment, EC2 instance profile, ECS task role), with optional IAM role assumption. Connections are read-only by default.
  - **Screens:** clusters, services, tasks with stop reasons, task definitions with JSON editing, CloudWatch logs and metrics, a service map, events, a security scan, an AWS shell terminal tab and ECS Exec.
  - **Actions:** scale, redeploy, roll back, run or stop tasks, register and deregister revisions, and create or delete services, each with a confirmation.
- AI assistant tools for ECS (read-only).
- Error boundaries: a failing view shows the error with **Try again** instead of a blank window.

### Fixed
- A quick pan on the Cluster Map or Service Map could blank the window.
- Task definition revision picker could jump to the newest revision while loading.

## [1.0.0] - 2026-10-18

### Added
- First public release:
  - Kubernetes resources, YAML editing with dry run, Cluster Map, Relationship Graph, Event Timeline, Monitor
  - logs, pod shells, an integrated terminal, port forwarding
  - Security Scan with fixes, Access (who-can, permission matrix, role editor), Helm, and the AI Assistant

[Unreleased]: https://github.com/AAnkitpatel/k8sconsole/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.4.0
[1.3.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.3.0
[1.2.1]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.2.1
[1.2.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.2.0
[1.1.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.1.0
[1.0.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.0.0
