# How to add a classification rule

The dashboard reads every `*.yaml` file in this directory and merges
them into one rule list, sorted by `priority`.  Adding a new rule is a
single edit to the right domain file — no code change needed.

## 1. Pick the right file

| Failure looks like… | Edit |
|---|---|
| Wait timeouts (`TimeoutException`, `page load timed out`, step timed out) | `01-timeout.yaml` |
| Selector / DOM problem (`NoSuchElement`, stale, click intercepted, not interactable) | `02-ui-locator.yaml` |
| Driver session crash / disconnect | `03-browser-session.yaml` |
| HTTP error from the app (5xx, 401/403, 404, missing event) | `04-api-backend.yaml` |
| Network / TLS / DNS / DB / OOM / permission | `05-environment.yaml` |
| Assertion mismatch (JUnit, Hamcrest, AssertJ) | `06-assertion.yaml` |
| Test data missing or null | `07-test-data.yaml` |
| Cucumber framework (pending / undefined / ambiguous / step-failed) or generic exception | `08-automation.yaml` |
| Maven / Gradle compile or dependency | `09-build-config.yaml` |

If the failure doesn't fit any existing file, create a new `10-<your-domain>.yaml`
and add the domain colour to `_meta.yaml`.

## 2. Pick a priority

Lower priority number wins.  The bands are:

| Band | Use for |
|---|---|
| 5 – 19 | **Very specific**, high-confidence matches.  Wins over anything else. |
| 20 – 49 | Specific TIER-1 matches (most rules live here). |
| 50 – 99 | TIER-2 — broader signatures (infra, browser, env). |
| 700 – 899 | Catch-alls — only fire when no specific rule matches. |
| 900+ | Reserved for the generic-exception fallback.  Don't use. |

When in doubt, slot your new rule **between two existing ones** at an
even number (priorities in the existing files are spaced by 2 on
purpose, so you always have room).

## 3. Schema cheat-sheet

```yaml
- name: "my_rule_name"          # snake_case, unique across ALL files
  priority: 42                  # see band table above
  domain: "API / Backend Service"  # must match a key in _meta.yaml's domain_colors
  subcategory: "HTTP 429"        # short noun phrase, shown in detail view
  impact: "Test Issue"           # "Product Regression Likely" | "Test Issue" | "Data Issue" | "Infrastructure Likely" | "Inconclusive"
  label: "Rate Limited"          # short chip text, shown in the Log Analysis column
  patterns:
    - "HTTP/1\\.1\" 429"          # YAML strings need backslashes doubled
    - "Too Many Requests"
  action: "Reduce request rate or check the rate-limiter config."
  scope: "global"                # always "global" for now
```

### Field notes

- **`name`** — used in logs + tests.  Stays stable forever; renaming
  invalidates anyone who searched for it.
- **`patterns`** — Python regex (case-sensitive by default; prefix with
  `(?i)` for case-insensitive).  At least one must match for the rule
  to fire.  First match anywhere in the (normalised) log wins.
- **`label`** — what users see as a chip in the table.  Keep it short:
  2–4 words.
- **`action`** — one sentence telling the on-call what to do next.
  Don't be vague ("check the logs"); name the service / file / step.

## 4. Test locally

```bash
source venv/bin/activate
python -c "
from jjat.pipeline import Classifier
c = Classifier(rules_path='config/rules')
# Paste a log snippet that should match your new rule:
r = c.classify('HTTP/1.1\" 429 Too Many Requests')
print(r.label, '/', r.matched_rule_name, '/ priority?', r.matched_pattern)
"
```

Expect your new rule's `label` + `matched_rule_name` in the output.
If a different rule fires, your priority is too low (raise it — lower
number wins) or the existing rule's regex is more specific than yours.

## 5. Common pitfalls

- **Duplicate name** — the loader rejects two files defining the same
  `name`.  Pick a fresh one.
- **Domain not in `_meta.yaml`** — the chip will render grey instead of
  the colour you expect.  Add the domain to `domain_colors` in
  `_meta.yaml`.
- **Regex too greedy** — `"Exception"` matches everything.  Anchor or
  qualify (`"java\\.lang\\.IllegalStateException"`).
- **YAML escaping** — backslashes need to be doubled (`\\d+`), and any
  string containing `:` or `#` should be wrapped in double quotes.

That's it.  Save the file, restart the dashboard, the rule is live.
