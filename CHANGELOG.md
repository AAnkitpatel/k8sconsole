# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/AAnkitpatel/k8sconsole/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.1.0
[1.0.0]: https://github.com/AAnkitpatel/k8sconsole/releases/tag/v1.0.0
