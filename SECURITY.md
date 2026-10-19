# Security policy

## Supported versions

Security fixes go into the latest release. Please upgrade to the newest version from the [releases page](https://github.com/AAnkitpatel/k8sconsole/releases) before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). If that isn't possible, email **a.ankitpatel01@gmail.com** with "K8sConsole security" in the subject.

Please include the affected version, what an attacker could do, and steps to reproduce. You'll get an acknowledgement within 5 working days. We'll agree a disclosure date with you once a fix is available, and credit you in the release notes unless you prefer otherwise.

## Scope

In scope: anything that lets K8sConsole leak credentials (kubeconfig, AWS, Claude API key), escape the renderer sandbox, bypass the IPC allow-list or input validation, make a change to a cluster or AWS account without the user's confirmation (including bypassing read-only mode), or send data to the AI assistant that should have been redacted.

Out of scope: vulnerabilities in Kubernetes, AWS or third-party services themselves, and issues that require an attacker who already controls the user's account or machine.

The security design is described in [docs/SECURITY.md](docs/SECURITY.md).
