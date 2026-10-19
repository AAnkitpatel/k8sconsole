# K8sConsole

[![CI](https://github.com/AAnkitpatel/k8sconsole/actions/workflows/ci.yml/badge.svg)](https://github.com/AAnkitpatel/k8sconsole/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/AAnkitpatel/k8sconsole)](https://github.com/AAnkitpatel/k8sconsole/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One desktop console for Kubernetes and Amazon ECS.** K8sConsole connects straight to your Kubernetes clusters from your kubeconfig, and to Amazon ECS with your AWS profiles or IAM role. There's nothing to install and no agents. It brings live resources, maps, monitoring, logs, shells, security checks, access control, Helm and an AI assistant together in one fast desktop app.

> **Download:** [latest release](https://github.com/AAnkitpatel/k8sconsole/releases/latest) (`.deb`, Linux x86-64, with SHA-256) · **Website:** [aankitpatel.github.io/k8sconsole](https://aankitpatel.github.io/k8sconsole/)

## Highlights

| Area | What you get |
|---|---|
| **Clusters** | Every context from `~/.kube/config`, `$KUBECONFIG`, added files and folders, or pasted YAML. Files are watched for changes. Works with client certificates, tokens, exec plugins (EKS/GKE/AKS/kubelogin), OIDC and proxies. Connections recover automatically. |
| **Resources** | Live tables for 38 built-in kinds plus any custom resource, filtered by what your cluster actually serves. Rich details, YAML editing with server-side dry run, conflict-safe apply, and create from YAML. |
| **Cluster Map** | A live map of each namespace: traffic → services → workloads → pods → config and storage, coloured by health. A node map shows every pod on its node. |
| **Relationship Graph** | Every object's connections: owners, selectors, routes, mounts, volumes, identities, nodes, autoscalers and network policies. |
| **Event Timeline** | Events laid out per object over time, with activity density, warning highlighting and filters. |
| **Monitor** | Live CPU, memory, network and disk with history charts, per-node and per-pod drill-downs, and request/limit markers. Data comes from the kubelet Summary API (agent-free) or metrics-server. |
| **Logs & shells** | Streaming logs (follow, previous, timestamps, since/tail, search, download) and interactive pod shells. |
| **Integrated terminal** | Tabbed zsh/bash. *Cluster shell* tabs bind `kubectl` to the selected cluster and namespace without editing your kubeconfig, with kubectl completion and inline, context-aware command suggestions. |
| **Security Scan** | Pod security, RBAC and network-exposure checks with a posture score, plain-language remediation, and one-click fixes that dry-run first. |
| **Access** | "Who can…?" answers, a permission matrix for any user, group or service account, your own access, and a visual Role/binding editor. |
| **Helm** | Releases, values, manifests, history, rollback, upgrade and uninstall, plus repositories, chart search, README/values and install with server-side dry run. |
| **AI Assistant** | Ask about your Kubernetes or ECS clusters in plain language. It investigates with read-only tools (resources, events, logs, metrics, ECS tasks and CloudWatch logs) and drafts fixes for you to review, dry-run and apply. It never changes anything on its own. Uses your own Claude API key; secret values and environment values are never sent. |
| **Amazon ECS** | A second workspace in the same app. Connect with an AWS profile (access keys, IAM Identity Center/SSO, `role_arn` profiles, credential process) or the default credential chain (environment, EC2 instance profile, ECS task role), optionally assuming an IAM role. **Read-only by default**: changes are blocked in the app until you switch it off. Clusters, services (deployments, events, target health, CPU/memory), tasks with stop reasons and exit codes, task definitions with JSON editing and revisions, CloudWatch logs per task or per service with live follow and filter patterns, a service map (load balancer → target group → service → tasks), an events feed, a security scan, and an *AWS shell* terminal bound to the profile and region. With write access: scale, redeploy, deploy or roll back a revision, enable ECS Exec, stop or run tasks, register revisions, create and delete services, each with a confirmation. |
| **Port forwarding & actions** | Pods and services (bound to 127.0.0.1), plus scale, rolling restart, evict, cordon, drain and CronJob trigger/suspend. Every change asks for confirmation. |

## Install

```bash
sudo apt install ./k8sconsole_1.1.0_amd64.deb
k8sconsole        # or open "K8sConsole" from your applications menu
```

Supported systems are Ubuntu 22.04 or newer and Debian 12 or newer, on x86-64. Optional extras:
- `kubectl` for the terminal's completion and suggestions
- `zsh` for inline command suggestions
- `helm` 3 for the Helm features
- the `aws` CLI v2 for the AWS shell, and AWS's Session Manager plugin for ECS Exec (everything else in the ECS workspace works without them)

Uninstall with `sudo apt remove k8sconsole`. Your settings in `~/.config/K8sConsole/` stay; delete that folder to remove them.

## Configuration

| What | Where |
|---|---|
| Clusters | Clusters view → *Add file*, *Add folder*, *Paste YAML*. `$KUBECONFIG` is read at launch. |
| Settings | Settings view; stored in `~/.config/K8sConsole/settings.json` (owner-only permissions) |
| AI Assistant | Open ✦ Assistant and add a Claude API key. It's encrypted with your OS keyring. Alternatively set `ANTHROPIC_API_KEY`. Choose the model, effort and log access in Settings. |
| Helm | `helm` on `PATH`, or set its path in Settings |
| Amazon ECS | Switch the sidebar to *Amazon ECS* and connect. Profiles come from `~/.aws/config` and `~/.aws/credentials` (or `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`). The last connection (profile, region, role, read-only) is remembered; credentials never are. |
| Custom data folder | `K8SC_USER_DATA_DIR=/path k8sconsole` |

## Privacy and security

- Nothing is installed in your clusters. The app only uses your kubeconfig and AWS credentials, and only in the background process. AWS keys are never shown in the app or written to its settings.
- AWS connections are read-only unless you switch that off: every create, update, stop or delete call is refused before it leaves the app. For extra safety, connect with an IAM role or profile that only has read permissions.
- The window that shows the UI is sandboxed: it has no direct access to your files, credentials or the network.
- The AI Assistant is optional and off until you add a key. When used, your question and the cluster data needed to answer it go to the Claude API. Secret values are never included. Log access can be turned off.
- There's no telemetry, no account and no licence server.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank window on some Wayland desktops | Start with `k8sconsole --ozone-platform=x11`. If that doesn't help, try `--disable-gpu`. |
| "TLS verification failed" | The kubeconfig's certificate authority doesn't match the server. Fix the CA rather than disabling verification. |
| "Unauthorized (401)" on EKS/GKE/AKS | Install and log in to the cluster's exec plugin (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`) so it's on `PATH`. |
| Monitor says "requests only" | Usage needs `nodes/proxy` permission (kubelet Summary API) or metrics-server. |
| Terminal shows no inline suggestions | Install `zsh`, or pick *zsh* in the terminal's shell menu. |
| Assistant: "API key was rejected" | Re-enter the key in the Assistant panel, or remove it in Settings and add it again. |
| Helm view: "helm was not found" | Install Helm 3 or set its path in Settings. |
| ECS: "AWS SSO session expired" | Run `aws sso login --profile <name>` (for example in the terminal), then connect again. |
| ECS: "requires an MFA code" | Use a profile with cached session credentials or SSO; MFA prompts are not supported yet. |
| ECS: cluster CPU chart is the services' average | Fargate publishes utilization per service. Turn on Container Insights for task-level metrics. |
| ECS Exec is unavailable | It needs a read-write connection with a profile (not an app-assumed role), the `aws` CLI, the Session Manager plugin, and ECS Exec enabled on the service. The Shell tab says which one is missing. |

## Contributing

K8sConsole is open source under the [MIT Licence](LICENSE), and contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the pull request rules and the checks CI runs, and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

Build, test and packaging details are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md), the design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and changes per version in [CHANGELOG.md](CHANGELOG.md). Third-party licences ship in `/opt/k8sconsole/THIRD_PARTY_NOTICES.txt`.

---

Kubernetes® is a registered trademark of The Linux Foundation. Amazon Web Services, AWS and Amazon ECS are trademarks of Amazon.com, Inc. or its affiliates. Claude is a trademark of Anthropic, PBC. K8sConsole is not affiliated with or endorsed by any of them.
