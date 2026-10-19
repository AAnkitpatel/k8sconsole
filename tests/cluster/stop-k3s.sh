#!/usr/bin/env bash
# Removes the disposable k3s test cluster container.
set -euo pipefail
docker rm -fv "${K8SC_K3S_NAME:-k8sc-test-k3s}"
