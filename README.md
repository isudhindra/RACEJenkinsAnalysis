<h1 align="center">Jenkins Analysis &amp; Execution Hub</h1>

<p align="center">
A local dashboard that pulls live job status from Jenkins, validates each job
against a release-promotion time, classifies failures from the console log,
and surfaces everything in one screen.<br>
<em>Each user runs their own instance.</em>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#prerequisites">Prerequisites</a> ·
  <a href="#setup">Setup</a> ·
  <a href="#configure-jenkins-instances">Configure</a> ·
  <a href="#using-the-dashboard">Use</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## Features

| Business                                          | User                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Faster release go/no-go decisions                 | Pick a promotion time → automatic PASS / PENDING / FAIL       |
| Earlier visibility of validation gaps             | Failures come pre-classified with evidence inline             |
| Failure-triage knowledge versioned in the repo    | Background refresh every 30 s, row flashes on change          |
| No server to run — each engineer hosts their own  | Bulk-select (dropdown, shift+click, paint) + one-click rerun  |

---

## Prerequisites

- **Python 3.8 or newer**
- A Jenkins instance you can reach over HTTPS
- A Jenkins API token &nbsp;·&nbsp; *Jenkins → your user → Configure → API Token*

**Python packages**

| Package    | Version  | Purpose                   |
| ---------- | -------- | ------------------------- |
| `Flask`    | `≥ 3.0`  | HTTP server + templating  |
| `requests` | `≥ 2.31` | Jenkins API client        |
| `PyYAML`   | `≥ 6.0`  | Loads `config/rules.yaml` |

---

## Setup

Pick your OS:

<details open>
<summary><strong>macOS</strong></summary>

&nbsp;

**1. Install** — from the project root:

```bash
python3 -m venv venv
source venv/bin/activate
pip install Flask requests PyYAML
```

**2. Set credentials** *(optional, recommended)* — add to `~/.zshrc`:

```bash
export JENKINS_NP_USERNAME="your.username"
export JENKINS_NP_API_KEY1="your-api-token"
```

```bash
source ~/.zshrc
```

> When both vars are set the dashboard shows a one-click **Authenticate
> with environment credentials** button. Otherwise paste credentials in
> the UI each time.

**3. Register `analyseJenkins`** *(optional one-command launcher)*:

```bash
bash setup/setup.sh
source ~/.zshrc       # or ~/.bash_profile if you're on bash
```

**4. Run**:

```bash
python app.py         # or, after step 3:  analyseJenkins
```

Server starts on **http://127.0.0.1:5000** and your default browser opens
automatically. `Ctrl+C` to stop.

</details>

<details open>
<summary><strong>Ubuntu / Linux</strong></summary>

&nbsp;

**1. Install**:

```bash
sudo apt update && sudo apt install -y python3-venv python3-pip
python3 -m venv venv
source venv/bin/activate
pip install Flask requests PyYAML
```

**2. Set credentials** *(optional, recommended)* — add to `~/.bashrc`:

```bash
export JENKINS_NP_USERNAME="your.username"
export JENKINS_NP_API_KEY1="your-api-token"
```

```bash
source ~/.bashrc
```

> When both vars are set the dashboard shows a one-click **Authenticate
> with environment credentials** button. Otherwise paste credentials in
> the UI each time.

**3. Register `analyseJenkins`** *(optional one-command launcher)*:

```bash
bash setup/setup.sh
source ~/.bashrc
```

**4. Run**:

```bash
python app.py         # or, after step 3:  analyseJenkins
```

Server starts on **http://127.0.0.1:5000** and your default browser opens
automatically. `Ctrl+C` to stop.

> **WSL users**: follow this section, not the Windows one. WSL is a
> Linux environment.

</details>

<details open>
<summary><strong>Windows (PowerShell)</strong></summary>

&nbsp;

**1. Install**:

```powershell
py -3 -m venv venv
venv\Scripts\Activate.ps1
pip install Flask requests PyYAML
```

> If PowerShell blocks `Activate.ps1`, run once:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

**2. Set credentials** *(optional, recommended)*:

```powershell
[Environment]::SetEnvironmentVariable("JENKINS_NP_USERNAME", "your.username", "User")
[Environment]::SetEnvironmentVariable("JENKINS_NP_API_KEY1", "your-api-token", "User")
```

Close and reopen PowerShell so the new variables are picked up.

> When both vars are set the dashboard shows a one-click **Authenticate
> with environment credentials** button. Otherwise paste credentials in
> the UI each time.

**3. Register `analyseJenkins`** *(optional one-command launcher)*:

```powershell
.\setup\setup.ps1
. $PROFILE
```

> PowerShell 5.1 and PowerShell 7+ have separate profiles. If you use
> both, run `.\setup\setup.ps1` inside each one.

**4. Run**:

```powershell
python app.py         # or, after step 3:  analyseJenkins
```

Server starts on **http://127.0.0.1:5000** and your default browser opens
automatically. `Ctrl+C` to stop.

</details>

---

## Configure Jenkins instances

Edit `config/contexts.json` to add Jenkins servers and predefined job
lists. Minimal example:

```json
{
  "instances": [
    {
      "id": "my-jenkins",
      "display_name": "My Jenkins (SIT)",
      "jenkins_url": "https://jenkins.example.com",
      "environment": "SIT",
      "predefined_job_lists": [
        {
          "id": "api-smoke-sit",
          "name": "API Smoke (SIT)",
          "job_list_file": "config/job_lists/api-smoke-sit.json",
          "environment": "SIT",
          "source_mode": "job_list"
        }
      ]
    }
  ],
  "defaults": { "max_workers": 15, "timeout": 30 }
}
```

> Job-list files live in `config/job_lists/`. Each is a JSON array of
> Jenkins job names — see the existing examples in that folder.

---

## Using the dashboard

| # | Step                  | What to do                                                          |
| - | --------------------- | ------------------------------------------------------------------- |
| 1 | **Pick an instance**  | Choose from the config panel at the top                             |
| 2 | **Authenticate**      | Click the env-creds shortcut, or paste username + token             |
| 3 | **Fetch jobs**        | Pick a view or predefined list → **Fetch Jobs**                     |
| 4 | **Validate release**  | *(Optional)* Set a Release Validation time to enable the column     |
| 5 | **Watch it work**     | Auto-refresh every 30 s — toggle off if you'd rather not            |

---

## Project layout

```text
.
├── app.py                  ← Flask app + routes
├── jenkins_client.py       ← Jenkins HTTP client (auth, retry, CSRF)
├── pipeline.py             ← Classifier + stage orchestration
├── models.py               ← Dataclasses + enums
├── setup/
│   ├── setup.sh            ← Register analyseJenkins (macOS / Linux)
│   └── setup.ps1           ← Register analyseJenkins (Windows)
│
├── config/
│   ├── contexts.json       ← Jenkins instances + predefined job lists
│   ├── rules.yaml          ← Failure-classification rules (hand-edited)
│   └── job_lists/          ← Per-environment job lists
│
├── static/
│   ├── css/dashboard-theme.css
│   └── js/                 ← Frontend modules (no build step)
│
└── templates/
    └── dashboard.html
```

---

## Troubleshooting

<details>
<summary><strong>Common issues</strong></summary>

&nbsp;

| Symptom | Fix |
| ------- | --- |
| `python: command not found` (Linux/Mac) | Use `python3` instead. |
| PowerShell blocks `Activate.ps1` | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |
| Port `5000` already in use | Stop the other process, or change the port at the bottom of `app.py`. |
| Browser shows stale UI after pull / redeploy | Hard-reload (`Cmd+Shift+R` Mac, `Ctrl+Shift+R` Win/Linux). Restarting the server bumps the cache-buster automatically. |
| Env-creds button doesn't appear | Both `JENKINS_NP_USERNAME` and `JENKINS_NP_API_KEY1` must be set in the **same shell** that launched `python app.py`. |
| Rerun returns `403` | Your Jenkins requires a CSRF crumb — the client fetches one automatically. If it still fails, check your token has *Job → Build* permission. |
| `analyseJenkins: command not found` after `setup/setup.sh` | Reload your shell: `source ~/.zshrc` (or `~/.bash_profile`, `~/.bashrc`). Opening a new terminal works too. |
| `setup/setup.sh` says "doesn't look like the project root" | `cd` into the project folder first, then re-run. |
| Moved the project, `analyseJenkins` now fails | Re-run `bash setup/setup.sh` (or `.\setup\setup.ps1`) from the new location — it replaces the old entry. |

</details>
