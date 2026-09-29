# Terminal-Bench 2.0 task status

Dataset revision: `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`. Historical run logs and batches were deleted at the user’s request. The summary below is retained to avoid rerunning previously passed tasks.

## Passed

| Task | Result |
| --- | --- |
| `cancel-async-tasks` | Passed |
| `log-summary-date-ranges` | Passed |
| `regex-log` | Passed |
| `sqlite-db-truncate` | Passed |
| `code-from-image` | Passed |
| `constraints-scheduling` | Passed |
| `gcode-to-text` | Passed on the later attempt; the earlier failed attempt remains recorded |
| `git-leak-recovery` | Passed |
| `llm-inference-batching-scheduler` | Passed |
| `openssl-selfsigned-cert` | Passed |
| `sparql-university` | Passed in batch `4e503e621189915f` |
| `db-wal-recovery` | Passed in batch `4e503e621189915f` |

## Failed

| Task | Result |
| --- | --- |
| `raman-fitting` | Failed. Initial attempt passed 2/3 checks; a dependency diagnostic still passed only 1/3. The model's fitted peak parameters did not meet the original verifier tolerances. See the run records under the evaluation data directory. |

## Pending

| Task | Upstream agent timeout | Preparation note |
| --- | ---: | --- |
| `merge-diff-arc-agi-task` | 900 s | Running in batch `75f59be5ffdb2b68`; preauthorized inside the outer task namespace. |
| `chess-best-move` | 900 s | Blocked: the previous prepared image used a different renderer/font. Restore upstream-equivalent input before submitting. |
| `model-extraction-relu-logits` | 900 s | Previous attempt failed during dependency installation before Agent execution. Both versions are now cached and installed offline into separate paths; running in batch `75f59be5ffdb2b68`. |
| `schemelike-metacircular-eval` | 2400 s | Previous run timed out because the batch overrode its upstream 2400 s limit with 1800 s. Re-test at 2400 s. |

The Git + ReLU batch runs two concurrent assignments with a 1800 s development budget each, using Qwen 3.8 Flash. Scheme retains its separate 2400 s budget. The shared service has three slots. Chess remains blocked on upstream-equivalent image preparation. Verifier timeouts remain task-specific.
