# Scripts

## Session Transcripts

Extract session transcripts for a workspace and optionally analyze them with pi subagents.

```bash
npx tsx scripts/session-transcripts.ts --output ./session-transcripts
npx tsx scripts/session-transcripts.ts --analyze --output ./session-transcripts
```

## Handoff Heuristics

Generate turn-level datasets for `/handoff` selection heuristics and optionally run model-based ranking to suggest better markers.

```bash
npx tsx scripts/handoff-heuristics.ts --goal-source auto --output ./handoff-heuristics
npx tsx scripts/handoff-heuristics.ts --analyze --top-k 8 --output ./handoff-heuristics
```

### Flags

- `--goal-source`: `auto`, `handoff`, `last-user`, `first-user`, `summary-goal`
- `--analyze`: run model-based ranking and marker suggestions
- `--top-k`: number of turns to select per session when analyzing
- `--output`: output directory (default `./handoff-heuristics`)
