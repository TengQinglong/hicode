# Terminal-Bench 2.0 task status

Dataset revision: `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

## Previously passed — 15 tasks

Historical results are preserved separately from the new regression. These are development results, not official leaderboard scores. The ten older run histories were deleted at the user's request; the five recent tasks retain evidence in the evaluation data directory.

| Task | Previous result | Current regression |
| --- | --- | --- |
| `cancel-async-tasks` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `log-summary-date-ranges` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `regex-log` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `sqlite-db-truncate` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `code-from-image` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `constraints-scheduling` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `gcode-to-text` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `git-leak-recovery` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `llm-inference-batching-scheduler` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `openssl-selfsigned-cert` | Previously passed; historical summary retained | Submitted · `2eadd7047743fdf4` |
| `schemelike-metacircular-eval` | 63 internal checks passed; run 4668c242fdc9493b | Submitted · `43873873e461285a` |
| `merge-diff-arc-agi-task` | 5/5 passed; run f1cdb7391b9c99dc (initial prompt submission repaired) | Submitted · `2eadd7047743fdf4` |
| `sparql-university` | 3/3 passed; run fac2c69ff2da42d7 | Submitted · `2eadd7047743fdf4` |
| `model-extraction-relu-logits` | Passed; run f4d8dadfa3b215bc. Earlier dependency setup timed out before Agent execution. | Submitted · `2eadd7047743fdf4` |
| `db-wal-recovery` | 7/7 passed; run ebba2972b65f73cf | Submitted · `2eadd7047743fdf4` |

## Not passed — excluded from this regression

- `raman-fitting`: numerical answer did not meet the original verifier tolerances. Initial attempt passed 2/3 checks; the dependency diagnostic passed 1/3. Historical raw logs were deleted; this summary remains.

## Not ready — excluded from this regression

- `chess-best-move`: restore the upstream-equivalent board image before testing. The previous substitute rendering is not accepted as an equivalent input.

## Current regression conditions

Re-run exactly the 15 previously passed tasks on a frozen snapshot containing the unified editing changes. Use Qwen 3.8 Flash, global concurrency 3, 1800 seconds per ordinary task and 2400 seconds for Scheme. Two budget groups share the same three execution slots. Each task receives one fresh attempt; no corrective follow-up or automatic retry. New outcomes do not overwrite previous passes.

Frozen payload: `payload-unified-edit-20260929`, based on `d71a8f7` plus the four runtime source files listed in its manifest. Both groups are submitted; runtime status is authoritative on the dashboard.
