#!/usr/bin/env bash
# Builds dist/k8sconsole_<version>_amd64.deb from the compiled app and the Electron runtime.
# Usage: bash build/scripts/package-deb.sh   (run from the repository root after `npm ci`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PKG=k8sconsole
PRODUCT="K8sConsole"
VERSION="$(node -p "require('./package.json').version")"
ARCH=amd64
ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"
MAINTAINER="${DEB_MAINTAINER:-K8sConsole Maintainers <a.ankitpatel01@gmail.com>}"
STAGE="$ROOT/build/stage"
DEST="$STAGE/root"
INSTALL_DIR="/opt/$PKG"
OUT="$ROOT/dist/${PKG}_${VERSION}_${ARCH}.deb"

ELECTRON_DIST="$ROOT/node_modules/electron/dist"
if [ ! -x "$ELECTRON_DIST/electron" ]; then
  echo "Electron binary missing; run: node node_modules/electron/install.js" >&2
  exit 1
fi

echo "==> Building application (stage-app.mjs builds, collects licences and stages the app)"

echo "==> Staging package tree"
rm -rf "$STAGE"
mkdir -p "$DEST$INSTALL_DIR" "$DEST/usr/bin" "$DEST/usr/share/applications" "$DEST/usr/share/doc/$PKG" "$DEST/DEBIAN"

cp -a "$ELECTRON_DIST/." "$DEST$INSTALL_DIR/"
mv "$DEST$INSTALL_DIR/electron" "$DEST$INSTALL_DIR/$PKG"
rm -f "$DEST$INSTALL_DIR/resources/default_app.asar"
mv "$DEST$INSTALL_DIR/LICENSE" "$DEST$INSTALL_DIR/LICENSE.electron.txt"
node build/scripts/flip-fuses.mjs "$DEST$INSTALL_DIR/$PKG"

# node-pty (native PTY for the integrated terminal) ships in resources/node-pty, outside the archive.
node build/scripts/stage-app.mjs linux >/dev/null
PTY_SRC="$ROOT/node_modules/node-pty"
cp -a "$STAGE/node-pty" "$DEST$INSTALL_DIR/resources/node-pty"
npx --no-install asar pack "$STAGE/app" "$DEST$INSTALL_DIR/resources/app.asar"

# Shell bootstrap resources (sourced by zsh from a real path).
mkdir -p "$DEST$INSTALL_DIR/resources/shell"
cp build/app/resources/shell/zsh-autosuggestions.zsh build/app/resources/shell/zsh-autosuggestions.LICENSE "$DEST$INSTALL_DIR/resources/shell/"

cp build/out/THIRD_PARTY_NOTICES.txt "$DEST$INSTALL_DIR/THIRD_PARTY_NOTICES.txt"
{
  printf '%s\nnode-pty@%s  —  MIT\n%s\n' "$(printf '=%.0s' {1..78})" "$(node -p "require('node-pty/package.json').version")" "$(printf -- '-%.0s' {1..78})"
  cat "$PTY_SRC/LICENSE"
  printf '\n%s\nzsh-autosuggestions@0.7.1  —  MIT\n%s\n' "$(printf '=%.0s' {1..78})" "$(printf -- '-%.0s' {1..78})"
  cat build/app/resources/shell/zsh-autosuggestions.LICENSE
} >> "$DEST$INSTALL_DIR/THIRD_PARTY_NOTICES.txt"

# AppArmor profile: lets Chromium create user namespaces for its sandbox on Ubuntu 23.10+.
cat > "$DEST$INSTALL_DIR/resources/apparmor-profile" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile $PKG $INSTALL_DIR/$PKG flags=(unconfined) {
  userns,

  include if exists <local/$PKG>
}
EOF

ln -s "$INSTALL_DIR/$PKG" "$DEST/usr/bin/$PKG"

mkdir -p "$DEST/usr/share/man/man1"
cat <<MANEOF | gzip -9n > "$DEST/usr/share/man/man1/$PKG.1.gz"
.TH K8SCONSOLE 1 "$(date +%Y-%m-%d)" "$VERSION" "User Commands"
.SH NAME
k8sconsole \\- agent-free desktop console for Kubernetes and Amazon ECS
.SH SYNOPSIS
.B k8sconsole
.SH DESCRIPTION
Graphical client for Kubernetes and Amazon ECS. Reads kubeconfig files from ~/.kube/config, the KUBECONFIG
environment variable and locations added in the application, and connects directly to the Kubernetes API.
For Amazon ECS it uses AWS profiles from ~/.aws/config and ~/.aws/credentials, or the default AWS credential chain
(environment variables, SSO cache, web identity, ECS task role, EC2 instance profile), optionally assuming an IAM role.
AWS connections are read-only unless the user switches that off.
.SH ENVIRONMENT
.TP
.B KUBECONFIG
Colon-separated list of kubeconfig files to load.
.TP
.B AWS_PROFILE, AWS_REGION, AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE
Standard AWS SDK settings used for the default credential chain.
.TP
.B AWS_ENDPOINT_URL
Standard AWS SDK endpoint override (for example a local AWS emulator).
.TP
.B K8SC_USER_DATA_DIR
Override the settings directory (default ~/.config/K8sConsole).
.SH FILES
~/.config/K8sConsole/settings.json and ~/.config/K8sConsole/kubeconfigs/
MANEOF

for size in 16 32 48 64 128 256 512; do
  mkdir -p "$DEST/usr/share/icons/hicolor/${size}x${size}/apps"
  cp "build/assets/icon-$size.png" "$DEST/usr/share/icons/hicolor/${size}x${size}/apps/$PKG.png"
done

cat > "$DEST/usr/share/applications/$PKG.desktop" <<EOF
[Desktop Entry]
Name=$PRODUCT
GenericName=Kubernetes and ECS Console
Comment=Agent-free desktop console for Kubernetes and Amazon ECS: workloads, logs, monitoring, terminals
Exec=$INSTALL_DIR/$PKG %U
Icon=$PKG
Terminal=false
Type=Application
Categories=Development;System;
Keywords=kubernetes;k8s;kubectl;cluster;helm;ecs;aws;fargate;devops;
StartupWMClass=$PRODUCT
EOF

cat > "$DEST/usr/share/doc/$PKG/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: $PKG
Source: local build

Files: *
Copyright: $(date +%Y) K8sConsole contributors
License: MIT

Files: opt/$PKG/*.so opt/$PKG/$PKG opt/$PKG/chrome* opt/$PKG/*.pak opt/$PKG/*.bin opt/$PKG/*.dat opt/$PKG/locales/*
Copyright: Electron contributors, The Chromium Authors
License: MIT and BSD-3-Clause and others
 See /opt/$PKG/LICENSE.electron.txt and /opt/$PKG/LICENSES.chromium.html.

Bundled npm packages: see /opt/$PKG/THIRD_PARTY_NOTICES.txt
EOF
printf '%s (%s) unstable; urgency=medium\n\n  * Amazon ECS workspace: AWS profiles, default credentials and IAM roles; clusters, services,\n    tasks, task definitions, CloudWatch logs and metrics, service map, events, security scan,\n    ECS Exec and AI assistant tools. Read-only connections by default (Electron %s).\n\n -- %s  %s\n' "$PKG" "$VERSION" "$ELECTRON_VERSION" "$MAINTAINER" "$(date -R)" | gzip -9n > "$DEST/usr/share/doc/$PKG/changelog.gz"

INSTALLED_SIZE=$(du -sk --exclude=DEBIAN "$DEST" | cut -f1)
cat > "$DEST/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Architecture: $ARCH
Maintainer: $MAINTAINER
Installed-Size: $INSTALLED_SIZE
Depends: libc6 (>= 2.28), libgcc-s1, libgtk-3-0t64 | libgtk-3-0, libnss3, libnspr4, libasound2t64 | libasound2, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0, libcups2t64 | libcups2, libglib2.0-0t64 | libglib2.0-0, libgbm1, libdrm2, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libxkbcommon0, libx11-6, libxcb1, libxext6, libdbus-1-3, libexpat1, libpango-1.0-0, libcairo2, libudev1, xdg-utils
Recommends: kubectl, zsh
Suggests: helm, awscli
Section: devel
Priority: optional
Homepage: https://kubernetes.io/
Description: Agent-free desktop console for Kubernetes and Amazon ECS
 K8sConsole is an agent-free desktop console for Kubernetes and Amazon ECS.
 For Kubernetes it reads your kubeconfig files and talks directly to the
 API: live resources and YAML, cluster maps, an event timeline, monitoring,
 logs, pod shells, an integrated terminal, port forwarding, a security scan
 with fixes, access-control tools and Helm. For Amazon ECS it uses your AWS
 profiles or IAM role: services, tasks, task definitions, CloudWatch logs
 and metrics, a service map, events, a security scan and ECS Exec, with
 read-only connections by default. An optional AI assistant investigates
 both and proposes changes for review. Nothing is installed in the cluster.
EOF

cat > "$DEST/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
# Chromium sandbox: prefer unprivileged user namespaces; fall back to the SUID helper only when they are unavailable.
if [ -L /proc/self/ns/user ] && unshare --user true 2>/dev/null; then
  chmod 0755 '$INSTALL_DIR/chrome-sandbox' || true
else
  chmod 4755 '$INSTALL_DIR/chrome-sandbox' || true
fi
if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then
  if apparmor_parser --skip-kernel-load --debug '$INSTALL_DIR/resources/apparmor-profile' >/dev/null 2>&1; then
    cp -f '$INSTALL_DIR/resources/apparmor-profile' '/etc/apparmor.d/$PKG'
    if ! { command -v ischroot >/dev/null 2>&1 && ischroot; } && command -v aa-enabled >/dev/null 2>&1 && aa-enabled --quiet 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache '/etc/apparmor.d/$PKG' || true
    fi
  fi
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
exit 0
EOF

cat > "$DEST/DEBIAN/postrm" <<EOF
#!/bin/sh
set -e
if [ "\$1" = "remove" ] || [ "\$1" = "purge" ]; then
  if [ -f '/etc/apparmor.d/$PKG' ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser --remove '/etc/apparmor.d/$PKG' >/dev/null 2>&1 || true; fi
    rm -f '/etc/apparmor.d/$PKG'
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
fi
exit 0
EOF
chmod 0755 "$DEST/DEBIAN/postinst" "$DEST/DEBIAN/postrm"

echo "==> Normalising permissions"
find "$DEST" -type d -exec chmod 0755 {} +
find "$DEST$INSTALL_DIR" -type f -exec chmod 0644 {} +
chmod 0755 "$DEST$INSTALL_DIR/$PKG" "$DEST$INSTALL_DIR/chrome_crashpad_handler" "$DEST$INSTALL_DIR/chrome-sandbox"
find "$DEST$INSTALL_DIR/resources/node-pty" -name '*.node' -exec chmod 0755 {} +
find "$DEST/usr" -type f -exec chmod 0644 {} +
chmod 0755 "$DEST/DEBIAN/postinst" "$DEST/DEBIAN/postrm"
(cd "$DEST" && find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
chmod 0644 "$DEST/DEBIAN/md5sums" "$DEST/DEBIAN/control"

echo "==> Building $OUT"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
fakeroot dpkg-deb --root-owner-group -Zxz --build "$DEST" "$OUT"
rm -rf "$STAGE"
dpkg-deb --info "$OUT" | sed -n '1,12p'
ls -la "$OUT"
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" | tee "$(basename "$OUT").sha256")
