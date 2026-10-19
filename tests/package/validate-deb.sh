#!/usr/bin/env bash
# Runs INSIDE a disposable Ubuntu container (see README "Package validation").
# Mounts: /pkg (dist dir), /src (repo, read-only), /node (Node.js install, read-only). Network: host (for the k3s test cluster).
set -uo pipefail
DEB=$(ls /pkg/k8sconsole_*_amd64.deb | head -1)
PKG=k8sconsole
PASS=0
FAIL=0
check() {
  local name="$1"
  shift
  if "$@" >/tmp/check.log 2>&1; then
    echo "PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $name"
    sed 's/^/      /' /tmp/check.log | tail -20
    FAIL=$((FAIL + 1))
  fi
}

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq xvfb xauth desktop-file-utils lintian zsh >/dev/null 2>&1

check "metadata: package name/arch" bash -c "test \"\$(dpkg-deb -f '$DEB' Package)\" = k8sconsole && test \"\$(dpkg-deb -f '$DEB' Architecture)\" = amd64"
check "install with apt (dependencies resolved)" apt-get install -y -qq "$DEB"
check "dpkg reports installed" bash -c "dpkg -s $PKG | grep -q 'Status: install ok installed'"
check "binary + launcher symlink present" bash -c "test -x /opt/$PKG/$PKG && test \"\$(readlink -f /usr/bin/$PKG)\" = /opt/$PKG/$PKG"
check "app.asar present, no sources/tests/node_modules inside" bash -c "test -f /opt/$PKG/resources/app.asar && ! test -e /opt/$PKG/resources/default_app.asar"
check "shared libraries all resolve" bash -c "! ldd /opt/$PKG/$PKG | grep -q 'not found'"
check "desktop entry validates" desktop-file-validate /usr/share/applications/$PKG.desktop
check "hicolor icons installed" bash -c "for s in 16 32 48 64 128 256 512; do test -f /usr/share/icons/hicolor/\${s}x\${s}/apps/$PKG.png || exit 1; done"
check "chrome-sandbox permissions are 0755 or 4755 root-owned" bash -c "stat -c '%a %U' /opt/$PKG/chrome-sandbox | grep -Eq '^(755|4755) root$'"
check "file ownership is root" bash -c "test -z \"\$(find /opt/$PKG ! -user root | head -1)\""
check "license notices shipped" bash -c "test -s /opt/$PKG/THIRD_PARTY_NOTICES.txt && test -s /usr/share/doc/$PKG/copyright"
check "md5sums verify" dpkg --verify $PKG
check "terminal: native PTY module unpacked and loadable" bash -c "test -f /opt/$PKG/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node && ldd /opt/$PKG/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node | grep -vq 'not found'"
check "terminal: zsh bootstrap resources shipped" test -s /opt/$PKG/resources/shell/zsh-autosuggestions.zsh
check "man page shipped in package (minimal images exclude /usr/share/man on install)" bash -c "dpkg-deb -c '$DEB' | grep -q usr/share/man/man1/$PKG.1.gz"

echo "---- lintian (informational) ----"
lintian --no-tag-display-limit "$DEB" 2>&1 | sort | uniq -c | sort -rn | head -40 || true
echo "---------------------------------"

export PATH=/node/bin:$PATH
check "hardening: ELECTRON_RUN_AS_NODE is ignored (RunAsNode fuse off)" bash -c "! timeout 20 env ELECTRON_RUN_AS_NODE=1 /opt/$PKG/$PKG -e 'console.log(\"NODE_MODE_\"+process.versions.electron)' 2>/dev/null | grep -q NODE_MODE_"
if [ -n "${K8SC_TEST_KUBECONFIG:-}" ]; then
  check "startup + UI smoke against disposable cluster (installed binary)" bash -c "cd /tmp && xvfb-run -a -s '-screen 0 1440x900x24' node /src/tests/e2e/smoke.mjs --exe /opt/$PKG/$PKG"
  cat /tmp/check.log | grep -E '✓|✗|E2E' || true
fi
check "Amazon ECS workspace against a local AWS stand-in (installed binary)" bash -c "cd /tmp && xvfb-run -a -s '-screen 0 1440x900x24' node /src/tests/e2e/ecs.mjs --exe /opt/$PKG/$PKG"
cat /tmp/check.log | grep -E '✓|✗|ECS E2E' || true
check "startup without any kubeconfig shows empty state" bash -c "cd /tmp && env -u K8SC_TEST_KUBECONFIG xvfb-run -a -s '-screen 0 1440x900x24' node /src/tests/e2e/smoke.mjs --exe /opt/$PKG/$PKG"

check "uninstall (purge)" apt-get purge -y -qq $PKG
check "files removed after purge" bash -c "! test -e /opt/$PKG && ! test -e /usr/bin/$PKG && ! test -e /usr/share/applications/$PKG.desktop && ! test -e /etc/apparmor.d/$PKG"
check "dpkg no longer knows the package" bash -c "! dpkg -s $PKG >/dev/null 2>&1"

echo
echo "Package validation: $PASS passed, $FAIL failed"
exit $FAIL
