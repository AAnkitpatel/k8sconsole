# Writing a K8sConsole extension

An extension is a folder named after its id containing `extension.json`. Install it from the Extensions view (*Add from JSON* or *Install file…*), or put the folder in the extensions folder (*Open folder*). Extensions are declarative: they never run code inside K8sConsole.

```json
{
  "apiVersion": 1,
  "id": "team-tools",
  "name": "Team tools",
  "version": "1.0.0",
  "description": "Shortcuts and policies for our clusters",
  "commands": [
    { "id": "logs", "title": "Tail logs", "command": "kubectl logs -f deploy/{{name}} -n {{namespace}}", "kinds": ["Deployment"] },
    { "id": "ecs", "title": "Describe service", "command": "aws ecs describe-services --cluster {{cluster}} --services {{service}} --region {{region}}", "kinds": ["EcsService"] }
  ],
  "links": [
    { "id": "grafana", "title": "Grafana", "url": "https://grafana.example.com/d/pods?var-namespace={{namespace}}&var-pod={{name}}", "kinds": ["Pod"] }
  ],
  "rules": [
    { "id": "team-label", "title": "Missing team label", "severity": "low", "kinds": ["Deployment"], "path": "metadata.labels.team", "check": "exists", "remediation": "Add a team label." },
    { "id": "registry", "title": "Image outside our registry", "severity": "high", "kinds": ["Deployment", "StatefulSet"], "path": "spec.template.spec.containers[].image", "check": "matches", "value": "^registry\\.example\\.com/" }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | Lowercase letters, digits and hyphens; must match the folder name. |
| `commands[].command` | One line. Shown as a button on matching objects; clicking it types the command into a new terminal tab. It is never run until you press Enter. |
| `links[].url` | http(s) only; placeholder values are URL-encoded. |
| `kinds` | Kubernetes kinds (`Deployment`, `Pod`, a CRD kind…) or `EcsService` / `EcsTask`. Leave empty for commands and links that apply everywhere. |
| Placeholders | `{{name}}`, `{{namespace}}`, `{{kind}}`, `{{context}}`, `{{cluster}}`, `{{service}}`, `{{task}}`, `{{container}}`, `{{region}}`. A button is disabled when a value is missing or contains characters other than letters, digits and `._:/@-`. |
| `rules[].path` | Dotted path into the object; `[]` checks every element of an array. |
| `rules[].check` | `exists`, `absent`, `equals`, `not-equals`, `matches` or `not-matches` (`value` is a string or a regular expression). |
| `rules[].severity` | `critical`, `high`, `medium` or `low`. Results appear in the Extensions view for the selected namespace. |
