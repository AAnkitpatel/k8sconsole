# K8sConsole security model

## Process isolation
- **Main process:** all Kubernetes and AWS access, credentials, the terminal (node-pty), Helm (CLI via `execFile`, no shell) and the AI assistant run in Electron's main process.
- **Renderer:** the UI runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and `webSecurity: true`, without webviews. It is served from a custom `app://` scheme with a strict Content-Security-Policy (`connect-src 'none'`), so the UI has no network access of its own.
- **Bridge:** the preload exposes exactly two functions (`invoke`, `on`) with fixed allow-lists of methods and events. Every IPC handler verifies that the sender is the app's own top-level page.
- **Navigation:** navigation, new windows, webviews and permission requests (camera, notifications, …) are blocked.
- **Electron fuses** in the shipped binary: RunAsNode, NODE_OPTIONS and `--inspect` are off; OnlyLoadAppFromAsar is on; cookie encryption is on; file-protocol extra privileges are off.

## Credentials
- Kubeconfig contents never reach the UI. Contexts are described by name, server, user name and auth *method* only.
- Pasted kubeconfigs, settings and downloaded logs are written with owner-only permissions (0600).
- The Claude API key is encrypted with the operating-system keyring (Electron `safeStorage`); without a keyring it is not stored, and `ANTHROPIC_API_KEY` can be used instead.
- Cluster terminals pin kubectl's context through a per-session overlay that contains no credentials. The user's kubeconfig is never modified.
- AWS credentials are resolved by the official AWS SDK (named profiles, SSO cache, credential process, environment, web identity, ECS task role, EC2 instance profile; optional STS AssumeRole). The app lists profile names and types only; key material is never read out, sent to the UI or stored. Remembered connections hold the profile name, region, role ARN and read-only flag. AWS shells receive `AWS_PROFILE`/`AWS_REGION`, never keys.

## Input validation
- REST paths are built from validated API versions, resource names, namespaces and object names (no traversal).
- Pod, container, port and replica inputs are validated in the main process.
- Helm releases, namespaces, chart references (`repo/chart` or `oci://`), versions and repository URLs are validated, and values are passed through a private temporary file.
- The `app://` protocol only serves files inside the bundled renderer directory.

## Amazon ECS read-only mode
- AWS connections start read-only. Three layers enforce it: the UI disables change actions, the ECS service layer refuses write operations, and a middleware on every AWS SDK client rejects any operation that is not a Describe/List/Get-style call before it is signed or sent.
- ECS Exec (an interactive shell in a container) counts as a change and is only offered on read-write connections. The shell connects directly from the main process to Session Manager (ECS `ExecuteCommand` returns a short-lived stream URL and token); keystrokes and output never pass through the aws CLI or a local plugin, and session logging configured on the cluster still applies.
- ECS names, ARNs, subnet and security-group IDs, revisions, counts and command overrides are validated in the main process before any call.

## MCP server
- Off by default. When enabled it listens on 127.0.0.1 only and requires a random 256-bit bearer token (compared in constant time, stored with owner-only permissions, rotatable in Settings).
- Requests with a non-loopback `Host` header or a browser `Origin` are rejected (DNS-rebinding and drive-by protection); bodies are limited to 1 MB.
- Only the assistant's read-only tools are exposed; the change-proposal tool is not, and secret and environment values stay redacted.

## Extensions
- Extensions are JSON manifests, validated on install and on load; no extension code runs inside the app.
- Commands are typed into a terminal for the user to read and run, never executed automatically, and only identifier-safe values (`[A-Za-z0-9._:/@-]`) are substituted, so an object name cannot inject shell syntax.
- Links must be http(s) and substituted values are URL-encoded; policy rules use a fixed set of checks on dotted paths, and prototype keys are refused.

## Changes to clusters
- Every mutating action asks for confirmation. Deletes, drains, Helm uninstalls, ECS service deletes, scaling a service to zero and deregistering a task definition require typing the name.
- YAML edits use optimistic concurrency and strict field validation, and offer a server-side dry run. Security fixes and assistant proposals show the exact change and run a dry run before they can be applied.
- Port forwards listen on 127.0.0.1 only.

## AI assistant
- **Read-only tools:** it has read-only tools only. Its single change-related tool shows a proposal to the user and applies nothing.
- **Untrusted data:** tool results are treated as untrusted data; the system prompt tells the model never to follow instructions found in cluster content.
- **Redaction:** Secret values, `last-applied-configuration` on Secrets, and credential-looking environment values are redacted before anything is sent. For ECS, all task definition environment values and secret references are removed. Pod and CloudWatch log access can be turned off.
- **ECS:** its ECS tools are read-only regardless of the connection mode; it describes ECS changes in words for the user to make.
- **Model call:** requests use the official Anthropic SDK with server-side refusal fallbacks enabled for supported models.

## Dependencies
- Versions are pinned exactly. `npm audit` reported no known vulnerabilities at release.
- Bundled third-party licences ship in `/opt/k8sconsole/THIRD_PARTY_NOTICES.txt`.
