# K8sConsole architecture

```
┌───────────────────────────── Electron main process (Node) ─────────────────────────────┐
│ main.ts           window, CSP, app:// protocol, menu, single instance, IPC, key storage │
│ controller.ts     one handler per IPC method; session lifecycle; health check            │
│ features.ts       graph, security scan/fix, access queries, assistant tool host          │
│ assistant.ts      Claude tool loop (official SDK, streaming, refusal fallbacks)          │
│ terminal*.ts      node-pty sessions; zsh/bash bootstrap; kubectl suggestions             │
│ helm.ts           helm CLI via execFile: releases, repos, search, install/upgrade        │
│ settings.ts       atomic 0600 JSON settings with schema sanitizing                        │
│ kube/kubeconfig   discovery (~/.kube, $KUBECONFIG, files, folders, pasted), watcher      │
│ kube/rest         HTTPS client on client-node's TLS/auth/proxy handling                   │
│ kube/resources    discovery, list/get, YAML apply (replace/create/server-side apply),    │
│                   delete, scale, restart, cordon, drain, evict, CronJob actions          │
│ kube/watch        list → watch with bookmarks, 410 relist, backoff reconnect             │
│ kube/streams      pod logs and exec sessions                                             │
│ kube/portforward  127.0.0.1 listeners; Service → ready pod mapping                       │
│ kube/monitor      usage sampling (kubelet Summary API / metrics-server) with history     │
│ kube/inventory    permission-tolerant listing for graph, scan and access                 │
│ aws/session       AWS SDK clients, credential chain / profiles / AssumeRole, read-only guard│
│ aws/ecs           ECS, CloudWatch metrics, ELB target health, EC2 security groups         │
│ aws/logs          CloudWatch Logs tailing per task container or per service              │
│ aws/controller    AWS connection, terminal binding, ECS Exec command, IPC validation     │
└──────────────▲──────────────────────────────────────────────┬──────────────────────────┘
               │ invoke('k8sc:<method>')                        │ send('k8sc:event:<name>')
┌──────────────┴──────── preload (sandboxed, contextIsolation) ─▼──────────────────────────┐
│ window.k8sc = { invoke(method, …args), on(event, listener) } with fixed allow-lists       │
└──────────────▲──────────────────────────────────────────────┬──────────────────────────┘
┌──────────────┴──────────────── Renderer (React 19, app://renderer) ──────────────────────┐
│ Shell: sidebar (catalog ∩ discovery), context and namespace pickers, status, docks       │
│ Kubernetes: Clusters, Overview, Monitor, resources, Cluster Map, Event Timeline,         │
│        Security, Access, Custom Resources, Helm, Port Forwards                            │
│ Amazon ECS: Connect, Overview, Monitor, Services, Tasks, Task Definitions, Service Map,  │
│        Events, Security Scan                                                              │
│ Panels: details (overview/YAML/events/relations/logs/shell), terminal dock, assistant     │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Shared engines (`build/app/src/shared`)

Pure, unit-tested modules used by both processes:

| Module | Purpose |
|---|---|
| `graph.ts` | Relationship graph: ownership, selectors, routes, mounts, volumes, identities, nodes, autoscalers, network policies; neighbourhoods; pod collapsing |
| `security.ts` | Rule engine for workloads, RBAC and network exposure; scoring; strategic-merge fix patches |
| `rbac.ts` | RBAC evaluation (bindings, implicit groups, wildcards, subresources, resourceNames), who-can, permission matrix, manifest builders |
| `timeline.ts` | Event lanes per object, first/last occurrences, density buckets |
| `ecs.ts` | ECS types, service/task health, awslogs stream mapping, service map, ECS security rules, read-only command classification |
| `format.ts`, `validation.ts`, `resources.ts` | Status summaries, quantities, manifest validation, safe REST path building |
| `api.ts`, `types.ts` | The typed IPC contract shared by all three layers |

## Key decisions

| Decision | Why |
|---|---|
| All cluster access in the main process | Credentials never enter the UI; the UI has no network access (CSP `connect-src 'none'`). |
| Thin REST client over `KubeConfig.applyToHTTPSOptions` | Reuses client-node's TLS, exec-plugin, OIDC and proxy handling while keeping full control of watches, timeouts and errors. |
| client-node `Log` / `Exec` / `PortForward` | Logs, shells and port forwards work without kubectl. |
| node-pty only for the local terminal | A real PTY is needed for zsh/bash; it ships unpacked next to the archive. |
| Server-side apply for proposals and the role editor | Create-or-update semantics with field-ownership conflict detection by the API server. |
| Assistant tools are read-only | The model can investigate and propose; only the user applies changes, after a dry run. |
| Helm through the CLI | Uses Helm's own release storage and chart handling. |
| AWS SDK v3 with the standard credential chain | Profiles, SSO, roles and instance credentials behave exactly as in the aws CLI; `AWS_ENDPOINT_URL` works for emulators and tests. |
| Read-only guard as SDK middleware | One enforcement point below every ECS call, so a missed UI check cannot send a change. |
| ECS Exec through the aws CLI | The Session Manager protocol stays in AWS's own plugin. |
