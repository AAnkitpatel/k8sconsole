#!/usr/bin/env bash
# Starts a DISPOSABLE single-node k3s cluster in Docker for integration/E2E tests and writes its kubeconfig.
# Never point the tests at a real cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=${K8SC_K3S_NAME:-k8sc-test-k3s}
PORT=${K8SC_K3S_PORT:-16443}
OUT="$ROOT/work/k3s/kubeconfig.yaml"
mkdir -p "$(dirname "$OUT")"

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  docker run -d --name "$NAME" --privileged -p "127.0.0.1:$PORT:6443" -e K3S_KUBECONFIG_MODE=644 \
    rancher/k3s:v1.31.4-k3s1 server --disable=traefik --tls-san=127.0.0.1 \
    "--kubelet-arg=eviction-hard=nodefs.available<1%,imagefs.available<1%,memory.available<100Mi" \
    --kubelet-arg=image-gc-high-threshold=99 --kubelet-arg=image-gc-low-threshold=98 >/dev/null
fi
docker start "$NAME" >/dev/null
echo "Waiting for the node to become Ready (if it never does, see README: inotify limits)..."
for _ in $(seq 1 90); do
  if docker exec "$NAME" kubectl get nodes 2>/dev/null | grep -q ' Ready'; then break; fi
  sleep 2
done
docker exec "$NAME" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://127.0.0.1:$PORT#; s/: default\$/: k3s-disposable/" > "$OUT"
chmod 600 "$OUT"
for _ in 1 2 3 4 5; do KUBECONFIG="$OUT" kubectl apply -f "$ROOT/tests/fixtures/demo.yaml" && break; sleep 3; done
KUBECONFIG="$OUT" kubectl -n k8sc-demo rollout status deploy/web --timeout=180s
echo "export K8SC_TEST_KUBECONFIG=$OUT"
