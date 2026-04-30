# Dev Inspector Plan

The Dev Inspector is the development view for understanding what Spark is doing.

It should not be the default user experience. Normal users get the clean overview. Developers get the full trace.

## Tabs

### Events

Shows append-only run events:

```text
plan.imported
spark.call.started
spark.call.completed
step.created
worker.task.created
worker.attempt.started
worker.attempt.completed
review.completed
```

### Spark Calls

Shows:

- mode
- model
- prompt template
- context packet
- JSON schema
- raw response
- parsed response
- token/cost data
- LangSmith trace link

### Worker Prompts

Shows:

- worker task
- runtime
- model
- command
- cwd
- prompt.md
- allowed paths
- forbidden paths
- verification commands

### Worker Output

Shows:

- terminal log
- stdout/stderr
- exit code
- parsed final report
- diff summary
- test output

### Context Packets

Shows exactly what was sent to Spark and why.

Must include:

- included items
- excluded items
- token estimate
- context budget

### State JSON

Shows current state objects:

- workspace
- run
- step
- worker task
- worker attempt
- review decision

## Buttons

- Copy prompt
- Copy response
- Export debug bundle
- Replay Spark call
- Replay worker prompt
- Compare prompt versions

## Redaction

Always redact:

- API keys
- auth headers
- `.env` values
- private SSH keys
- tokens
- cookies
