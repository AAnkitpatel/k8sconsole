# Signing and notarizing the macOS app

Without a Developer ID signature and Apple notarization, macOS shows *“Apple could not verify ‘K8sConsole’ is free of malware…”* on first launch. The Release workflow signs, notarizes and staples the app automatically once the secrets below exist. Without them it keeps producing ad-hoc signed builds. Both paths use the hardened runtime and are tested in CI.

## One-time setup (about 30 minutes, plus Apple's enrolment review)

### 1. Join the Apple Developer Program
Enrol at <https://developer.apple.com/programs/enroll/> as an individual (USD 99 per year). You need an Apple ID with two-factor authentication. Apple usually approves within a few days.

### 2. Create a “Developer ID Application” certificate (no Mac needed)
```bash
# On any machine with OpenSSL. Keep devid.key private.
openssl req -new -newkey rsa:2048 -nodes -keyout devid.key -out devid.csr \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=IN"
```
At <https://developer.apple.com/account/resources/certificates/add> choose **Developer ID Application** (G2 Sub-CA), upload `devid.csr`, and download `developerID_application.cer`. Then bundle the certificate and key:
```bash
openssl x509 -inform DER -in developerID_application.cer -out devid.pem
openssl pkcs12 -export -legacy -inkey devid.key -in devid.pem -name "Developer ID Application" -out devid.p12
# choose a strong export password; it becomes MACOS_CERTIFICATE_PASSWORD
```

### 3. Create an App Store Connect API key (for notarization)
At <https://appstoreconnect.apple.com/access/integrations/api>: **Team Keys → Generate API Key**, with access **Developer**. Download `AuthKey_<KEYID>.p8` (Apple allows the download only once) and note the **Key ID** and the **Issuer ID** shown above the key list.

### 4. Add the repository secrets
```bash
R=AAnkitpatel/k8sconsole
base64 -w0 devid.p12 | gh secret set MACOS_CERTIFICATE_P12 -R $R
gh secret set MACOS_CERTIFICATE_PASSWORD -R $R          # paste the export password
gh secret set APPLE_API_KEY_P8 -R $R < AuthKey_<KEYID>.p8
gh secret set APPLE_API_KEY_ID -R $R --body "<KEYID>"
gh secret set APPLE_API_ISSUER -R $R --body "<ISSUER-ID>"
```
Then delete the local `devid.key`, `devid.p12` and `.p8` files, or move them to a password manager.

### 5. Check it
Run **Actions → Release → Run workflow** with *publish* unticked. The macOS job must report `source=Notarized Developer ID` from `spctl` and a valid stapled ticket. The next tagged release is then signed and notarized, and its release notes drop the “Open Anyway” instructions.

## How it works
- `build/scripts/package.mjs` signs with the certificate in `CSC_LINK` when present, enables notarization when the API key is present too, and otherwise falls back to ad-hoc signing.
- **Entitlements:**
  - `build/assets/entitlements.mac.plist` contains only `allow-jit`, which V8 needs.
  - The ad-hoc variant also disables library validation, because ad-hoc signatures have no Team ID.
- The Release workflow writes the API key to the runner's temporary folder only for the build step. It verifies the signature, the hardened runtime and (for signed builds) Gatekeeper's assessment, and runs the UI test against the app from the mounted `.dmg` before anything is published.
