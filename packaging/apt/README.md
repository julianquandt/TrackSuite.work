# apt repository

The `apt_repo` CI job (`.github/workflows/build.yml`) publishes a GPG-signed,
statically-generated apt repository to the **public** repo's `gh-pages` branch on
every `v*` tag. Debian/Ubuntu users install once and then update with
`apt upgrade`. Served at:

```
https://julianquandt.github.io/TrackSuite.work/apt
```

The repo is stateless: each run regenerates `Packages`/`Release` from the
accumulated `pool/` of `.deb` files, so there is no reprepro database to keep.

## One-time maintainer setup

Do this once, then every tagged release updates the repo automatically.

### 1. Create a signing key (on your machine)

```bash
gpg --full-generate-key
#   Kind: RSA and RSA   ·   Size: 4096   ·   Expiry: your call (0 = none)
#   Name: TrackSuite.work Repository Signing Key
#   Email: apt@tracksuite-work.julianquandt.com   ·   set a passphrase
```

Find the fingerprint and export the (private) key:

```bash
gpg --list-secret-keys --keyid-format=long        # note the key id / fingerprint
gpg --armor --export-secret-keys <FINGERPRINT> > apt-signing-private.asc
```

### 2. Add repository secrets (in the PRIVATE repo — CI runs there)

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `APT_GPG_PRIVATE_KEY` | full contents of `apt-signing-private.asc` |
| `APT_GPG_PASSPHRASE` | the key's passphrase |

`PUBLIC_TOKEN` (push access to the public repo) already exists for the other
publish jobs. Delete `apt-signing-private.asc` afterward; keep the key backed up
somewhere safe — losing it means users must re-import a new one.

### 3. Enable GitHub Pages (on the PUBLIC repo)

`julianquandt/TrackSuite.work` → Settings → Pages → Source: **Deploy from a
branch**, Branch: **gh-pages** / **/(root)**. (The first tagged release creates
the `gh-pages` branch; enable Pages once it exists.)

## What users run

The canonical, always-current instructions live at
`https://julianquandt.github.io/TrackSuite.work/apt/` (generated with the real
package name). In short:

```bash
curl -fsSL https://julianquandt.github.io/TrackSuite.work/apt/tracksuite-work.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/tracksuite-work.gpg
echo "deb [signed-by=/usr/share/keyrings/tracksuite-work.gpg] https://julianquandt.github.io/TrackSuite.work/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/tracksuite-work.list
sudo apt update && sudo apt install tracksuite.work
```

## Notes / follow-ups

- Currently amd64 only (matches the release matrix).
- The pool accumulates every release's `.deb`; prune later if it grows large.
- Optional: teach the desktop updater to skip its "download the installer" flow
  when it was installed from apt, and point users at `apt upgrade` instead.
