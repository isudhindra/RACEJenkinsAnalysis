# How to add a classification rule

You open the RACE dashboard. One job in the overnight run is red. The "Log Analysis" column just says **Inconclusive** — which tells you nothing. You click into the job, scroll the console, and spot it almost immediately:

```
HTTP/1.1" 429 Too Many Requests
```

Staging is throttling us again. You've seen this three times this month. It would be so much nicer if RACE just *said* "Rate Limited" next to the build, the way it does for timeouts and locator failures.

Good news: that's exactly what rules are for, and you can add one in about five minutes — entirely from the dashboard, no terminal needed for the first pass.

## What is a rule, anyway?

A **rule** is a short label (e.g. "Rate Limited") plus a few search phrases (e.g. `Too Many Requests`). When any phrase appears in a failed job's console log, the label shows up as a chip in the dashboard's **Log Analysis** column. RACE ships with about a hundred of these already; you're just going to add one more.

---

## Step 1 — Ask RACE what it currently sees

In the dashboard header, click the **Test Classification** icon (right next to **Diagnostics**). A panel slides open with two text boxes.

1. Copy the failing job's console log (or just the chunk around the error — a few hundred lines is plenty).
2. Paste it into the **Console log** box.
3. Leave the **Candidate YAML** box empty for now.
4. Click **Classify**.

Under the hood the panel sends your text to RACE's live rules and shows you the verdict:

> **Matched rule:** `generic_exception_fallback`  
> **Label:** Inconclusive  
> **Matched pattern:** `Exception`  
> **Impact:** Inconclusive

That confirms it: nothing specific fired, so the generic catch-all won. Time to fix that.

---

## Step 2 — Draft a rule, right there in the panel

Don't close the panel. Scroll down to the **Candidate YAML** box and type a draft rule in. Here's the shape — seven fields, all short:

```yaml
rules:
  - name: "http_429_rate_limited"        # snake_case, unique
    priority: 32                          # lower number wins
    domain: "API / Backend Service"       # must exist in _meta.yaml
    subcategory: "HTTP 429"               # noun phrase for the detail view
    impact: "Infrastructure Likely"       # one of five fixed values (see card below)
    label: "Rate Limited"                 # the chip text (2-4 words)
    patterns:
      - "HTTP/1\\.1\" 429"
      - "Too Many Requests"
    action: "Staging API throttled us. Slow the test's request rate or ask Platform to raise the staging quota."
    scope: "global"                       # always "global" for now
```

Click **Classify** again. The panel layers your candidate over the live rules in a sandbox (your draft is never saved yet — nothing in production has changed), re-runs the classification, and shows the new result:

> **Matched rule:** `http_429_rate_limited`  
> **Label:** Rate Limited  
> **Matched pattern:** `Too Many Requests`  
> **Impact:** Infrastructure Likely

That's the chip you wanted. If you got the *wrong* match — or no match at all — tweak the YAML in the box and click Classify again. Iterate as many times as you like; the panel is a free sandbox.

---

## Step 3 — Save the rule for real

Now the rule needs to live in a file. Pick the file that fits your rule's **domain**:

| If your rule is about… | Save into |
|---|---|
| Wait or page-load timeouts | `01-timeout.yaml` |
| Selectors, stale elements, click-intercepted | `02-ui-locator.yaml` |
| Driver crashes / disconnects | `03-browser-session.yaml` |
| **HTTP errors from the app (5xx, 4xx, 429)** | **`04-api-backend.yaml`** |
| Network, TLS, DNS, DB, OOM, permissions | `05-environment.yaml` |
| Assertion mismatches (JUnit, AssertJ, Hamcrest) | `06-assertion.yaml` |
| Missing or null test data | `07-test-data.yaml` |
| Cucumber pending / undefined / framework | `08-automation.yaml` |
| Maven / Gradle compile or dependency | `09-build-config.yaml` |

Our 429 rule is an API thing, so it goes in `04-api-backend.yaml`. Open that file (in your editor of choice, or ask a teammate to commit it) and paste the rule block — exactly as you finalised it in the panel — at the bottom, keeping the indentation consistent with the rules above it.

> **Skip the restart forever.** Set the environment variable `RACE_HOT_RELOAD=1` once when launching the dashboard. From then on, RACE watches `config/rules/` and reloads any change within about 5 seconds. Save the file, refresh the dashboard, done. Without it, you need to restart the dashboard process for the new rule to take effect.

Either way, the next overnight run will tag this failure as **Rate Limited** instead of Inconclusive. Mission accomplished.

---

## Reference card — the rule fields

| Field | What goes in it |
|---|---|
| `name` | Snake-case identifier. Must be unique across **all** rule files. Don't rename it later — it's used in logs and tests. |
| `priority` | Lower number wins. Most new rules: **20–49**. Catch-alls: **700–899**. Existing rules are spaced by 2, so there's always room. |
| `domain` | Failure family. Must match a key in `_meta.yaml` (e.g. `API / Backend Service`) or the chip renders grey. |
| `subcategory` | Short noun phrase shown in the detail view (e.g. `HTTP 429`). |
| `impact` | One of: `Product Regression Likely`, `Test Issue`, `Data Issue`, `Infrastructure Likely`, `Inconclusive`. |
| `label` | The chip text users see. 2–4 words. |
| `patterns` | A list. Each entry is a search pattern. **At least one must match** for the rule to fire. |
| `action` | One sentence telling the on-call what to do next. Name the service or file — not "check the logs". |
| `scope` | Always `"global"` for now. |

**About patterns:** they're case-sensitive Python regex, but 90% of the time five to ten plain characters lifted straight from the error line are all you need (`Too Many Requests` works fine). If you must use a backslash — say, to match a literal dot — double it in YAML: write `\\.` to mean `\.`. Need case-insensitive? Prefix the pattern with `(?i)`.

---

## Common slips

- **Duplicate `name`.** The loader rejects two rules sharing a name, even across different files. Pick something fresh.
- **Domain not in `_meta.yaml`.** Your chip will render grey instead of the colour you expected. Add the domain under `domain_colors` in `_meta.yaml` (or stick to an existing one).
- **Pattern too generic.** `"Exception"` matches almost every Java stack trace. Anchor it: `"java\\.lang\\.IllegalStateException"`.
- **YAML escaping.** Double your backslashes (`\\d+`, not `\d+`), and wrap any pattern containing `:` or `#` in double quotes.

---

That's it — paste, classify, iterate, save. The dashboard will already know what to call it.
