<h1 align="left">RACE — Release Assurance & Confidence Engine</h1>

<p align="left">
  One screen for every Jenkins job in a release. See what passed, what failed,
  what's still pending — and re-run the reds without leaving the page.<br>
  <em>Local-only. VPN-gated. Nothing leaves your laptop.</em>
</p>

<br>

## What it does

- Lists every Jenkins job in a single live table — green, red, in progress, queued.
- Explains failures in one line — timeout, missing data, browser crash, infra blip.
- Pins a **release time** and flags each job **PASS / PENDING / FAIL** against it.
- Reruns selected failures in one click; the table auto-refreshes every 30 seconds.
- Generates a local API token so only the dashboard (not random other apps on your box) can drive it.

## Why use it

From the moment a release is promoted, every related Jenkins job needs to be tracked, executed, and passed before sign-off. RACE replaces the spreadsheet-and-six-tabs ritual with a single dashboard that knows which jobs belong to the release, classifies failures, and gives you one button to retry. It's built for QA, release engineering, and dev managers who own the green-light call.

<br>

## Quick start

Pick your OS. Each block has two parts: a **first-time setup** you do once, and an **every-time launch** you use afterwards.

> Replace `<project-folder>` with the actual folder name from your clone or unzip.

<details open>
<summary><strong>macOS</strong></summary>

&nbsp;

### First time only

**1. Install Python.** In Terminal, run `python3 --version`. If it reports 3.10 or newer you're set. Otherwise grab the installer from [python.org/downloads](https://www.python.org/downloads/).

**2. Set up the project — copy the whole block.**

```bash
cd ~/Downloads/<project-folder>
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.lock.txt && pip install -e . --no-deps
cat > .env <<'EOF'
JENKINS_TEST_USERNAME=
JENKINS_TEST_API_KEY=
EOF
chmod 600 .env
# open .env and fill in your Jenkins username + API token
bash scripts/setup.sh
```

The final line installs `analyseJenkins` as a shell command — written into `~/.zshrc` (or `~/.bash_profile` for bash users).

**3. Open a fresh Terminal window** and launch from anywhere:

```bash
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically. `Ctrl+C` to stop.

### Every time after that

```bash
analyseJenkins
```

</details>

<details open>
<summary><strong>Windows</strong></summary>

&nbsp;

### First time only

**1. Install Python.** In PowerShell, run `py --version`. If it reports 3.10 or newer you're set. Otherwise download from [python.org/downloads](https://www.python.org/downloads/) and **tick "Add Python to PATH"** on the first installer screen.

**2. Set up the project — copy the whole block.**

```powershell
cd C:\path\to\<project-folder>
py -3 -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.lock.txt; pip install -e . --no-deps
@"
JENKINS_TEST_USERNAME=
JENKINS_TEST_API_KEY=
"@ | Set-Content -Path .env -Encoding UTF8
# open .env in Notepad and fill in your Jenkins username + API token
.\scripts\setup.ps1
```

> If PowerShell blocks `Activate.ps1`, run this once and retry:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

The final line installs `analyseJenkins` as a PowerShell command — written into your `$PROFILE`.

**3. Open a fresh PowerShell window** and launch from anywhere:

```powershell
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically. `Ctrl+C` to stop.

### Every time after that

```powershell
analyseJenkins
```

</details>

<details open>
<summary><strong>Linux / Ubuntu</strong></summary>

&nbsp;

### First time only

**1. Install Python and the venv tooling.**

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
```

**2. Set up the project — copy the whole block.**

```bash
cd ~/<project-folder>
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.lock.txt && pip install -e . --no-deps
cat > .env <<'EOF'
JENKINS_TEST_USERNAME=
JENKINS_TEST_API_KEY=
EOF
chmod 600 .env
# open .env and fill in your Jenkins username + API token
bash scripts/setup.sh
```

The final line installs `analyseJenkins` as a shell command — written into `~/.bashrc` (or `~/.zshrc`).

**3. Open a fresh terminal** and launch from anywhere:

```bash
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically. `Ctrl+C` to stop.

### Every time after that

```bash
analyseJenkins
```

</details>

> Prefer not to keep credentials on disk? Skip the `.env` block above and use shell env vars or the OS keychain instead — see [Configuration](#configuration). Either path works; `.env` is just the most convenient default.

<br>

## Using the dashboard

1. **Sign in.** With `.env` populated, one button auto-authenticates. Otherwise paste your Jenkins URL, username, and API token. *(Generate the token in Jenkins → your profile → Configure → API Token.)*
2. **Choose a view** — for example *PRP1 All Jobs* — or pick a saved job list.
3. **Click Fetch Jobs.** Every job loads with its current status.
4. **Set a release time** *(optional)*. The *Release Status* column lights up with **PASS / PENDING / FAIL** for each job against that moment.
5. **Rerun the reds.** Tick failing rows and hit **Rerun**.

That's the whole tool.

<br>

## Configuration

All configuration is environment-variable based. RACE supports three ways to provide credentials — pick the one that fits your workflow.

> RACE is a local-only, VPN-gated tool. All three options below are acceptable for that threat model. The differences are workflow and how the secret sits on your machine — read the short trade-off note on each and pick what suits you.

### Option 1 — Shell environment variables (preferred, ephemeral)

Set the credentials in your current shell, then launch. Values live in RAM for that one session only — when the terminal closes, they're gone.

**macOS / Linux**

```bash
export JENKINS_TEST_USERNAME=svc-account@example.com
export JENKINS_TEST_API_KEY=11abcd…your-jenkins-api-token
analyseJenkins
```

**Windows PowerShell**

```powershell
$env:JENKINS_TEST_USERNAME = "svc-account@example.com"
$env:JENKINS_TEST_API_KEY  = "11abcd…your-jenkins-api-token"
analyseJenkins
```

*Trade-off:* the `export` / `$env:` line lands in your shell history (`~/.bash_history`, PSReadLine, etc.). Clear shell history afterwards if that matters in your environment.

### Option 2 — `.env` file (persistent, convenient)

The install steps already wrote a skeleton `.env` in the project root. Fill in the two lines, then lock the file:

```
JENKINS_TEST_USERNAME=svc-account@example.com
JENKINS_TEST_API_KEY=11abcd…your-jenkins-api-token
```

```bash
chmod 600 .env       # owner read/write only
```

`.env` is in `.gitignore`, and RACE warns at startup if the file is readable by anyone other than you — fix it with `chmod 600 .env` if you see that warning. Best for everyday use when you don't want to re-paste the token on every fresh terminal.

*Trade-off:* the file exists on disk, so it can be captured by backups, search indexers, or an accidental `git add -f`. `0600` permissions plus the gitignore keep this well-controlled in practice.

### Option 3 — OS keychain (strongest, optional)

For users who want zero secrets on disk and zero shell-history exposure, fetch the token from the OS keychain at launch.

**macOS** (built-in `security` command):

```bash
# one-time: prompts for the token and stores it in the Keychain
security add-generic-password -a $USER -s jenkins-api -w

# every launch (wrap in a shell alias so daily use stays one command)
export JENKINS_TEST_USERNAME=svc-account@example.com
export JENKINS_TEST_API_KEY=$(security find-generic-password -s jenkins-api -w)
analyseJenkins
```

**Linux** — equivalent via `secret-tool` from `libsecret-tools` (GNOME Keyring / KDE Wallet).
**Windows** — equivalent via the `CredentialManager` PowerShell module (`Get-StoredCredential`).

### Precedence

Shell env vars take precedence over `.env` values. So you can keep your normal credentials in `.env` and override `JENKINS_MAX_WORKERS=12` for a single launch without editing the file.

### Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JENKINS_TEST_USERNAME` | yes | — | Jenkins service-account username/email. |
| `JENKINS_TEST_API_KEY` | yes | — | Matching Jenkins API token. |
| `JENKINS_MAX_WORKERS` | no | `24` (range **1–64**) | Concurrent Jenkins API calls during a Fetch/Refresh. Raise on a strong master; lower if you see HTTP 429/503. |
| `JENKINS_POLL_WORKERS` | no | `15` (range **1–32**) | Concurrency for the background auto-refresh poll. Tuned separately so polling doesn't compete with user fetches. |
| `RACE_HOT_RELOAD` | no | off | Set to `1` to reload `config/rules/*.yaml` without restarting RACE. **Off by default for security** (see below). |
| `RACE_FRESH_TOKEN_ON_BOOT` | no | on (`1`) | The local API token is rotated on every RACE restart by default. Set to `0` to keep a stable token across restarts (rare — useful only when a long-lived CI session can't re-read `~/.race/token` between calls). |

> Out-of-range or non-numeric tuning values are silently ignored; the defaults stand.

The same Jenkins credential pair works across every environment configured in `config/contexts.json` — one sign-in covers all subsequent API calls. If the pair is missing or rejected, the manual username + API-token fields appear as a fallback.

<br>

## Security model

RACE adds a few app-layer guards so misbehaving local code (a browser tab pointed somewhere odd, an accidental script, a hostile YAML rule) can't drive the dashboard into doing something silly.

### Defence-in-depth

| Guard | Role |
|---|---|
| **X-RACE-Token** on `/api/*` | Small extra friction against accidental local cross-origin access. Not a strong control on a single-user laptop — see note below. |
| **SSRF guard** on Jenkins URL | Refuses outbound requests to private/loopback/metadata addresses unless explicitly allowed. |
| **Per-IP rate limit** (flask-limiter) | Caps runaway loops and accidental fork-bombs. |
| **ReDoS-safe regex** (`regex` package with per-pattern timeout) | Hostile or unfortunate YAML rule patterns can't hang the dashboard. |
| **Redacted error responses** | Stack traces, file paths, and credential fragments are stripped from API error bodies. |
| **Rule hot-reload off by default** | `RACE_HOT_RELOAD=1` is opt-in, so anyone with write access to `config/rules/` can't silently inject patterns at runtime. |

### Local API token (X-RACE-Token)

RACE mints a **fresh** per-machine token on every boot and stores it at `~/.race/token` (mode `0600`). Browsers pick it up automatically from a meta tag, so normal usage is invisible. The token never outlives the current process — **restart = rotation**. It's a small defence-in-depth measure layered on top of the controls above, not the primary protection; anything running as you on the same machine can read the file while the process is alive.

A symlinked or wrong-owned `~/.race/token` is *not* silently overwritten — RACE refuses to touch it, logs a clear warning, and falls back to an in-memory token for the session so the dashboard stays usable.

**Opting out of rotation.** Set `RACE_FRESH_TOKEN_ON_BOOT=0` to keep a stable token across restarts. Useful only when a long-lived CI session can't re-read the file between calls; everyday users should leave it at the default.

### Opting into rule hot-reload

By default RACE loads `config/rules/*.yaml` once at boot. If you're authoring rules and want live reload, set:

```bash
RACE_HOT_RELOAD=1 analyseJenkins
```

<br>


## Project layout

```
.
├ app.py                       ← entry point
├ pyproject.toml               ← dependencies + Ruff / mypy config
├ race/                        ← backend package
│   ├ application.py           ← Flask factory
│   ├ jenkins_client.py        ← HTTP client (auth, retry, CSRF)
│   ├ pipeline.py              ← Classifier + Stage-1 / Stage-2
│   ├ models.py                ← dataclasses + enums
│   ├ routes/                  ← one Blueprint per API domain
│   └ lib/                     ← shared helpers (state, creds, sse, …)
├ static/  templates/          ← vanilla-JS frontend
├ config/                      ← contexts.json + rules/*.yaml
└ scripts/                     ← setup.sh / setup.ps1 / lock.sh
```

<br>


### Adding a classification rule

Rules are YAML in `config/rules/`. The author's guide is [`config/rules/HOW-TO-ADD-A-RULE.md`](config/rules/HOW-TO-ADD-A-RULE.md) — start there. Draft and test your rule in the in-dashboard **Test Classification** panel, then save it to the matching file. Set `RACE_HOT_RELOAD=1` so you don't restart between iterations.

<br>

## Troubleshooting

### If the browser shows something odd

Try these in order — most issues clear at step 1 or 2.

1. **Hard-refresh the page** — `Cmd/Ctrl + Shift + R`. Fixes most after-update glitches and clears the red *"RACE session expired"* banner. (The amber *"Jenkins rejected the stored credentials"* banner is different — that one needs a credential update, see step 4.)
2. **If the page is still broken, or the red banner keeps coming back** — restart RACE (`Ctrl+C` in the terminal, then `analyseJenkins` again) and hard-refresh once more. Restarting rotates the local token and pulls everything fresh.
3. **Open the in-app Diagnostics panel** — the small Diagnostics icon in the dashboard header. RACE captures auth issues, failed fetches, classifier warnings, and 401s there in plain English. This is the right first stop for anything you can't see on the page.
4. **If login keeps failing** — open `.env` (or your shell env vars) and re-check `JENKINS_TEST_USERNAME` and `JENKINS_TEST_API_KEY`. The terminal where RACE is running shows the exact reason; look for `[WARN]` or `[ENV-AUTH]` lines.
5. **As a last resort** — open the browser DevTools console (`F12` → Console tab). Useful when something fails before the Diagnostics panel even loads.

### General

| If you see this… | Try this |
|---|---|
| `python: command not found` | Use `python3`, or close and reopen Terminal so `PATH` updates. |
| `analyseJenkins: command not found` | Open a **fresh** terminal window — the shortcut only loads in new shells. |
| Want to launch the manual way | `cd` into the project, then `source venv/bin/activate && python app.py` (macOS / Linux) or `venv\Scripts\Activate.ps1 ; python app.py` (Windows). |
| Dashboard looks weird after an update | Hard-refresh: `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Windows / Linux). |
| Test counts show only `—` | Hover the dash — the tooltip explains exactly why. |
| Port 5000 is busy | Stop the other app, or change the port at the bottom of `app.py`. |
| Red banner: *"RACE session expired (local token rotated)"* / repeated `401` across dashboard calls | The local API token rotated under your tab (RACE restarted). Hard-refresh once (`Cmd/Ctrl+Shift+R`). If the banner returns, restart RACE — every restart rotates the token automatically. Need a refresher? `bash scripts/token-help.sh`. |
| Amber banner: *"Jenkins rejected the stored credentials (401)"* | Your `JENKINS_TEST_USERNAME` / `JENKINS_TEST_API_KEY` are stale. Update them in your shell env or `.env`, then restart RACE. Hard-refresh will **not** clear this — the credentials must change. |
| `401` from `/api/*` in `curl` or a CI script | Attach the local API token: `-H "X-RACE-Token: $(cat ~/.race/token)"`. |
| Boot log shows *"in-memory token … fingerprint=sha256:…"* | `~/.race/token` is unwritable, symlinked, or owner-mismatched. RACE is running fine with a session-only token. To restore on-disk persistence: fix the file (permissions/ownership/symlink) and restart RACE. Run `bash scripts/token-help.sh` for the full explainer. |
| Jenkins auth fails after the API key was rotated upstream | Update `JENKINS_TEST_API_KEY` in your shell env or `.env`, then restart RACE. The manual login fields stay available as a fallback in the dashboard. |

<br>


## Dependency lockfile

`requirements.lock.txt` is a clean pinned lockfile generated from `pyproject.toml`. It is **autogenerated — do not edit by hand**. Every transitive dependency carries a `# via …` annotation so PR review stays readable.

After touching the `dependencies` block in `pyproject.toml`, regenerate it:

```bash
bash scripts/lock.sh
# (under the hood: pip-compile --strip-extras --quiet --output-file=requirements.lock.txt pyproject.toml)
```

Commit `pyproject.toml` and `requirements.lock.txt` together.

Periodic CVE scan:

```bash
pip-audit -r requirements.lock.txt
```

Validate against the corporate PyPI mirror after any lockfile change. Run from a clean venv on the supported Python floor (3.10) so you're testing the mirror, not stale local wheels:

```bash
pip cache purge
python3.10 -m venv /tmp/race-mirror-check && source /tmp/race-mirror-check/bin/activate
pip install --dry-run --no-cache-dir -r requirements.lock.txt
```

If a pin reports `No matching distribution`, ask the mirror admin to trigger a re-sync, or pin the affected package one minor older in `pyproject.toml` and re-run `bash scripts/lock.sh`.

**Why no `--generate-hashes`?** RACE is a local-only internal tool installed inside a VPN-gated corporate environment via the corp PyPI mirror. The supply-chain protection that hash-locking provides is already covered by the corp install path, so the committed lockfile stays small and reviewable. If security ever asks for strict hash verification, generate the artifact on demand:

```bash
pip-compile --generate-hashes --output-file=requirements.hashes.txt pyproject.toml
# install with: pip install --require-hashes -r requirements.hashes.txt
```

`requirements.hashes.txt` is **not** committed — it's an on-demand compliance artifact.

<br>

<sub><em>Created by Sudhindra Immidi.</em></sub>
