# Agent rules for Fusion

## Context hygiene
- Never read or search `viewer/data/*`, `*.rlog` or `*.log` in full. Give the job to a `scout` and ask for a digest of 40 lines or fewer.
- Read `viewer3d/viewer.js` by line range or symbol, never whole. Don't re-read a file you read earlier in the same turn unless it changed.
- Disassembly and memory-probe scripts (eval or bash) print at most 200 lines per call. Write longer output to a file and search it.
- Never search `~/.omp/agent/sessions`. Use `history://` or `agent://` instead.

## Parity check
- `node viewer3d/tools/parity-check.mjs <name>` (default `aoe4_245598603`) reads `viewer/data/<name>.js`. Exit 0 prints `parity OK`; exit 1 prints `MISMATCH <check>: <n>` lines, or a stack trace when the recording is missing.
- Report only the exit code and the `MISMATCH` lines. A stack trace is a setup problem, not a parity failure: stop and report it.

## Escalation
Stay on the current model by default. Dispatch the `re-escalation` agent when:
- the same `MISMATCH` category survives two fix attempts;
- the work needs new build 11308 memory offsets or signatures;
- Havok tagfile or animation decoding in `viewer3d/tools/havok/` has to change.
