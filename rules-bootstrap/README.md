# rules-bootstrap

One-time utility that generates a starter `rules.yaml` from real error samples, removing the manual effort of building classification rules from scratch when onboarding a new project.

## How it works

The utility reads raw error samples from `sample.json`, then runs a deterministic pipeline (no LLMs or external AI) through 8 stages:

1. **Text normalization** - strips timestamps, IDs, memory addresses, stack traces, ANSI codes, and other unstable fragments
2. **Signature extraction** - identifies exception classes, HTTP status codes, and key error phrases from each sample
3. **Grouping** - clusters similar errors by signature fingerprint, then merges groups with overlapping key phrases and matching subcategories
4. **Category inference** - votes on the best domain/subcategory/impact classification based on recognized error patterns
5. **Pattern generation** - derives regex patterns that would match the samples, using case-aware syntax compatible with the Classifier
6. **Rule naming** - generates snake_case rule names from subcategories
7. **YAML output** - writes a complete `rules.yaml` with fallback labels, domain colors, tiered rules, and a generic catch-all
8. **Report generation** - produces a human-readable summary of groups, domains, and pattern counts

## Workflow

```
1.  Collect representative error samples from your project into sample.json
2.  Run:  python bootstrap_rules.py
3.  Review the generated rules.yaml and rules.report.txt
4.  Refine rules manually (adjust patterns, merge groups, add actions)
5.  Copy to config/rules.yaml for production use
```

## Usage

```bash
# Default: reads sample.json, writes rules.yaml
python bootstrap_rules.py

# Custom input/output paths
python bootstrap_rules.py -i my_errors.json -o draft_rules.yaml

# Require at least 2 samples per group to generate a rule
python bootstrap_rules.py --min-samples 2
```

## sample.json format

A JSON array of objects. Each object needs at minimum an `error_text` field. Optional fields like `job_name` and `build_number` are used for reporting but not required.

```json
[
  {
    "job_name": "my-test-suite",
    "build_number": 42,
    "error_text": "java.lang.NullPointerException: Cannot invoke method on null..."
  },
  {
    "job_name": "api-tests",
    "build_number": 100,
    "error_text": "HTTP/1.1 502 Bad Gateway\nResponse body: ..."
  }
]
```

## Output

Two files are generated:

- **rules.yaml** - ready-to-use rules file compatible with the dashboard's Classifier (`pipeline.py`). Rules are organized into tiers by sample frequency, with match counts and affected jobs noted in comments.
- **rules.report.txt** - human-readable analysis report showing group details, domain distribution, sample snippets, and pattern summaries.

## Collecting samples

To build `sample.json` for your project, gather error text from Jenkins console logs of failed builds. Good sources include:

- Jenkins build console output (the full text or relevant error sections)
- Test framework output (JUnit XML failure messages, pytest output, Mocha/Jest errors)
- CI/CD pipeline logs (Docker build failures, deployment errors, infrastructure issues)

Aim for 30-100 representative samples covering the common failure modes in your project. The utility works best with diverse samples spanning multiple error categories.

## After bootstrapping

The generated `rules.yaml` is a starting point. To refine it:

- Merge or split rules that don't align with your team's mental model
- Adjust priority values to control which rules match first (lower = higher precedence)
- Add project-specific patterns that the utility couldn't infer from samples alone
- Tune the `action` text to include team-specific runbooks or escalation paths
- Remove the `# match_count` comments once the rules are finalized

New error types that appear later can be added manually to the rules file in the normal way. The utility is not needed for ongoing maintenance.
