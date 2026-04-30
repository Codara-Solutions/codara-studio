# LangSmith + OpenRouter Observability Plan

The goal is to see exactly what Spark sends to OpenRouter during development without leaking secrets.

## Recommended approach

Use two layers:

1. Spark Dev Inspector inside the app
2. LangSmith tracing for OpenRouter calls

The Dev Inspector should store local debugging data:

- Spark mode
- prompt template version
- context packet
- schema
- raw model response
- parsed JSON
- validation errors
- worker prompt
- review packet

LangSmith should show external LLM trace data:

- input/output messages
- token usage
- cost
- model/provider
- timing/latency

OpenRouter supports broadcasting traces to LangSmith from OpenRouter, which can reduce custom tracing code in the app.

## Environment variables

Use environment variables or secure Electron settings for keys. Do not commit real keys.

```bash
OPENROUTER_API_KEY=...
LANGSMITH_API_KEY=...
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=spark-agent-dev
```

## Secret policy

Never write raw API keys to:

- terminal logs
- Dev Inspector events
- worker prompts
- worker reports
- debug bundles
- markdown docs

Show only whether a key exists:

```text
OPENROUTER_API_KEY = present
LANGSMITH_API_KEY = present
```

## Spark call metadata to store locally

```json
{
  "id": "spark-call-001",
  "mode": "step_planning",
  "model": "openrouter/model-id",
  "template_version": "spark-planner-v1",
  "context_packet_id": "ctx-001",
  "started_at": "...",
  "completed_at": "...",
  "status": "complete",
  "input_tokens": 0,
  "output_tokens": 0,
  "estimated_cost": 0,
  "langsmith_trace_url": null
}
```

## Development workflow

1. Build OpenRouter client.
2. Add local SparkCall event storage.
3. Enable OpenRouter → LangSmith broadcast or SDK tracing.
4. Verify traces show up in LangSmith.
5. Add redaction before exporting debug bundles.
