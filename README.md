<h1 align="center">Jenkins Job Analysis Tool</h1>

<p align="center">
A single screen that shows you every Jenkins job's status, explains why the red
ones failed, and lets you re-run them with one click.<br>
Runs on your own laptop. Nothing leaves your machine.
</p>

<br>

## What you can do with it

- See all your jobs in one table — green, red, in progress.
- Read a one-line reason for each failure (timeout, missing data, browser crash, …).
- Pick a "release time" — the dashboard tells you which jobs **passed**, **need re-running**, or **haven't started yet** for that release.
- Tick the failed jobs, hit one button, walk away. It re-runs them all.
- The screen refreshes itself every 30 seconds.

<br>

## Install and run

Pick your operating system below. Each section has two parts: a **first-time setup** you do once, and a **every-time launch** you use afterwards.

> In every command, replace `<project-folder>` with the actual name of the folder you got when you cloned the repo or unzipped the download.

<details open>
<summary><strong>macOS</strong></summary>

&nbsp;

### First time only

**1. Install Python.**  In Terminal, run `python3 --version`. If it says 3.8 or newer you're set. Otherwise grab the installer from [python.org/downloads](https://www.python.org/downloads/) and run it.

**2. Go into the project folder, then run everything below in one go.**

```bash
cd ~/Downloads/<project-folder>
python3 -m venv venv
source venv/bin/activate
pip install Flask requests PyYAML python-dotenv
cp .env.example .env          # then open .env and fill in your Jenkins credentials
bash scripts/setup.sh
```

The last line adds `analyseJenkins` as a shell command for you — written into `~/.zshrc` (or `~/.bash_profile` if you use bash).

**3. Open a new Terminal window**, then start the dashboard from anywhere with:

```bash
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically.  Press `Ctrl+C` to stop.

### Every time after that

```bash
analyseJenkins
```

</details>

<details open>
<summary><strong>Windows</strong></summary>

&nbsp;

### First time only

**1. Install Python.**  In PowerShell, run `py --version`. If it says 3.8 or newer you're set. Otherwise download from [python.org/downloads](https://www.python.org/downloads/) and run the installer — **tick "Add Python to PATH"** on the first screen.

**2. Go into the project folder, then run everything below in one go.**

```powershell
cd C:\path\to\<project-folder>
py -3 -m venv venv
venv\Scripts\Activate.ps1
pip install Flask requests PyYAML python-dotenv
Copy-Item .env.example .env   # then open .env in Notepad and fill in your Jenkins credentials
.\scripts\setup.ps1
```

> If PowerShell blocks the `Activate.ps1` script, run this once and then retry:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

The last line adds `analyseJenkins` as a PowerShell command for you — written into your PowerShell `$PROFILE`.

**3. Open a new PowerShell window**, then start the dashboard from anywhere with:

```powershell
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically.  Press `Ctrl+C` to stop.

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

**2. Go into the project folder, then run everything below in one go.**

```bash
cd ~/<project-folder>
python3 -m venv venv
source venv/bin/activate
pip install Flask requests PyYAML python-dotenv
cp .env.example .env          # then open .env and fill in your Jenkins credentials
bash scripts/setup.sh
```

The last line adds `analyseJenkins` as a shell command for you — written into `~/.bashrc` (or `~/.zshrc` if you use zsh).

**3. Open a new terminal**, then start the dashboard from anywhere with:

```bash
analyseJenkins
```

The browser opens at **http://127.0.0.1:5000** automatically.  Press `Ctrl+C` to stop.

### Every time after that

```bash
analyseJenkins
```

</details>


<br>

## Using the dashboard

1. **Sign in.** If you've populated `.env` (see below), one button auto-authenticates. Otherwise paste your Jenkins web address, username, and API token. *(Generate the token in Jenkins under your profile → Configure → API Token.)*
2. **Choose a view** — for example "PRP1 All Jobs" — or pick a saved job list.
3. **Click Fetch Jobs.** Every job loads with its current status.
4. **(Optional) Set a release time.** The *Release Status* column lights up with **PASS / PENDING / FAIL** for each job against that moment.
5. **Re-run the reds.** Tick the failing rows and use the **Rerun** button.

That's the whole tool.

<br>

## Credentials (.env file)

The dashboard reads one Jenkins service-account credential pair from `.env` in the project root:

```
JENKINS_TEST_USERNAME=svc-account@example.com
JENKINS_TEST_API_KEY=11abcd…your-jenkins-api-token
```

The same pair works across every Jenkins environment configured in `config/contexts.json` — once you authenticate, the session covers all further API calls. If the pair is missing or rejected, the manual username + API-token fields appear as a fallback. `.env` is gitignored, so credentials never leave your machine.

A ready-to-edit template lives at `.env.example`; the install steps above copy it to `.env` for you.

<br>

## Stuck?

| If you see this… | Try this |
|---|---|
| "python: command not found" | Use `python3` instead, or close and reopen Terminal so PATH updates. |
| `analyseJenkins: command not found` | Open a fresh terminal window — the shortcut only loads in new shells. |
| Want to launch the manual way | `cd` into the folder, then `source venv/bin/activate && python app.py` (macOS / Linux) or `venv\Scripts\Activate.ps1 ; python app.py` (Windows). |
| Dashboard looks weird after an update | Hard-refresh the page: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows / Linux). |
| Test counts show only "—" | Hover the dash — the tooltip tells you exactly why. |
| Port 5000 is busy | Close the other app using it, or change the port at the bottom of `app.py`. |

<br>


### Project layout

```
.
├ app.py                       ← entry point
├ pyproject.toml               ← dependencies + Ruff/mypy
├ jjat/                        ← backend package
│   ├ application.py           ← Flask factory
│   ├ jenkins_client.py        ← HTTP client (auth, retry, CSRF)
│   ├ pipeline.py              ← Classifier + Stage-1 / Stage-2
│   ├ models.py                ← dataclasses + enums
│   ├ routes/                  ← one Blueprint per API domain
│   └ lib/                     ← shared helpers (state, creds, sse, …)
├ static/  templates/          ← vanilla-JS frontend
├ config/                      ← contexts.json + rules.yaml
└ scripts/                     ← setup.sh / setup.ps1
```

### Conventions

- Python files `snake_case.py`; classes `PascalCase`; functions `snake_case`; leading `_` for module-internal.
- JavaScript files `kebab-case.js`; functions `camelCase`.
- Hard cap: 400 lines per Python file, 500 per JS file.
- Layering: `lib/` ← `routes/` ← `application.py`. Never the other direction.

### Adding a new endpoint

1. Open the right file in `jjat/routes/`.
2. Add the `@bp.route(...)` handler.
3. (New blueprint?) Register it in `jjat/routes/__init__.py`.
4. (Shared helper?) Put it in `jjat/lib/`.

### Tuning fetch speed

Two knobs, both `.env`-aware (or `export` if you prefer):

- `JENKINS_MAX_WORKERS` — concurrent Jenkins API calls during a Fetch/Refresh. Default **24**, range **1–64**. Raise on a strong Jenkins (40 is fine); lower if you see HTTP 429/503 or the Jenkins master is under load.
- `JENKINS_POLL_WORKERS` — concurrency for the background auto-refresh poll (cheap status-only calls). Default **15**, range **1–32**. Tuned separately so polling doesn't compete with user-triggered fetches.

Out-of-range or non-numeric values are silently ignored; the defaults stand.

### If this ever leaves "local laptop" territory

In rough order: gunicorn + nginx, Docker, CI with Ruff/mypy/pytest, dashboard auth, structured logging, rate-limiting, secrets provider.


<sub><em>Created by Sudhindra Immidi.</em></sub>
