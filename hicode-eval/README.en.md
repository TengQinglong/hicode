# HiCode Eval

[简体中文](README.md)

Run public programming tasks through HiCode on a persistent Linux container. Submit batches from the CLI, watch the full TUI in a browser, and automatically collect test results and logs. Each task gets one independent attempt, with no corrective follow-up prompts or automatic retries.

Reviewed tasks are listed in the [catalog](config/terminal-bench.json). This is a development regression tool: the shared system, ARM64 environment, and configurable time limits differ from official benchmark conditions. Results are not official leaderboard scores.

Query batch execution and scores with the CLI `status` command. Keep personal task reviews and environment preparation records outside the checkout.

## Directory and records

```text
src/
  cli.ts     Command-line entrypoint
  host/      Host scheduling, state, Linux transport, and payload preparation
  worker/    Linux execution, grading, terminal capture, and cleanup
  web/       Read-only dashboard and terminal component
config/      Task adapters, fixed regression groups, and configuration examples
tests/       Offline regression tests
skills/      Codex batch evaluation instructions
```

Task files, source payloads, credentials, and run records stay outside the checkout. `config/` contains shared declarations, fixed regression groups, and examples; the model, release, budget, and results for each actual submission are recorded under `<data-dir>/batches/` and `runs/`. Keep temporary task selections outside the checkout, for example in `../hicode-eval-data/batch-configs/`. Personal status and machine preparation notes can go under `../hicode-eval-data/records/`.

## 1. Prepare the environment and dataset

Run these commands from the **HiCode repository root**. The host needs Git, Bun 1.3+, Python 3.9+, and the Docker CLI. On macOS, first follow the [development container guide](../.devcontainer/README.en.md) to install Colima, Compose, and Buildx and create the `hicode` VM. Native Linux can use another Docker context, but requires the equivalent nested sandbox policy described in that guide.

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh eval-start
```

The first run builds the development base and a dedicated evaluation image with tmux, Python 3.13, pytest 8.4.1, and pytest-json-ctrf 0.3.5. Subsequent runs reuse the image and system tools; task-specific Python dependencies are installed into separate directories. The `hicode-eval-linux` container mounts only a dedicated data volume, without your checkout, home directory, or Docker socket. The development container does not need to be running.

Download the dataset outside this repository and pin the reviewed revision:

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`config/terminal-bench.json` verifies the full file hashes of supported tasks and rejects modified versions. Tasks and reference solutions are not distributed in this repository; follow the upstream dataset's license and usage conditions. Harbor is not required.

## 2. Configure a model and freeze the source

Run `bun run start`, configure a connection, API key, and model with `/providers`, select the default with `/model`, then exit. The evaluation service reads settings from **this checkout and `~/.hicode`**, not from task directories or another project.

Alternatively, copy [config/example.model.json](config/example.model.json) to `../hicode-eval-data/model.local.json`, fill in the model ID, endpoint, and API key environment variable name, and pass `--model-config ../hicode-eval-data/model.local.json` to `serve`. The JSON **does not contain the API key value**. Credentials are resolved from the process environment, this checkout's `.env`, then `~/.hicode/.env`; `/providers` can save them without putting a key in command-line arguments. Supported `source` values are `qwen`, `deepseek`, `glm`, and `openrouter`.

Freeze the version to evaluate:

```bash
bash hicode-eval/eval.sh prepare --payload ../hicode-eval-data/payload-v1
```

A clean worktree is required by default. Add `--snapshot-worktree` to include uncommitted changes under `src/` and to `package.json`, `bun.lock`, and `tsconfig.json`. The payload contains only those runtime inputs and records the commit, overlaid files, and archive hash. Use a new output directory for each version.

## 3. Start the service and submit a batch

```bash
bash hicode-eval/eval.sh serve \
  --data-dir ../hicode-eval-data/runs \
  --tasks ../terminal-bench-2 \
  --payload ../hicode-eval-data/payload-v1 \
  --docker-context colima-hicode \
  --machine hicode-eval-linux \
  --concurrency 3
```

Startup deploys the fixed source release. Production dependencies are reused when unchanged, or installed once at this stage. Once the address appears, open **http://127.0.0.1:8878**. The web interface is read-only. Keep the server terminal open and submit from a second terminal:

```bash
bash hicode-eval/eval.sh catalog
bash hicode-eval/eval.sh submit --file hicode-eval/config/example.batch.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

Replace `BATCH_ID` with the ID returned on submission. One batch can contain different execution limits. Each task declares an `id` and an optional `agentSeconds`:

```json
{
  "name": "This test round",
  "tasks": [
    { "id": "cancel-async-tasks", "agentSeconds": 900 },
    { "id": "log-summary-date-ranges", "agentSeconds": 1800 }
  ],
  "concurrency": 3
}
```

Omitting `agentSeconds` uses the service default (1800 seconds); each task accepts 30–7200 seconds. Concurrency is capped at 4 and cannot exceed the service limit. The page displays each task's limit, and completed tasks automatically release their slots. Actual and original task budgets are recorded separately; extended budgets are development evaluation conditions. The fixed 15-task regression group is [regression15.json](config/regression15.json).

Use `--source` and `--model` together to override a configured model, or `--model-config` for an explicit connection. If changing the port, pass the same `--port` to every CLI command. Run only one service per evaluation machine, and do not deploy another version while tasks are active.

A person or an agent such as Codex can operate the CLI. **Scheduling and grading do not depend on Codex.** Real tasks incur usage charges from your configured model provider; offline tests do not call a model.

## Evaluation network modes

The service defaults to open networking. Use `serve --network isolated` to change the default, or set a mode per submitted batch:

```json
{"name":"Independent evaluation","network":"isolated","concurrency":3,"tasks":[{"id":"regex-log"}]}
```

- `open`: the Agent may use the network while solving the task.
- `isolated`: preparation and grading retain network access. During the attempt, curl, pip, Fetch and other processes cannot access the internet; model calls use a fixed model-only gateway. Prepared local dependency caches remain available.

An omitted mode inherits the service default. Each batch freezes its choice; active tasks are not switched and other batches are unaffected. Isolation failure stops preparation instead of falling back to open access. The real model credential stays outside the actor namespace. The gateway rejects arbitrary destinations, redirects and provider-side search tools. Actor mounts expose only this task, its runtime and its dependencies. Preparation caches, other tasks, grader inputs and terminal capture logs remain host-side; the task’s own HiCode storage and request logs remain available.

## Grading, logs, and shutdown

Database, image, and calendar inputs are copied individually from the reviewed `inputs` manifest in `config/terminal-bench.json` and verified by hash, rather than copying the entire task directory. The image task requires a model with explicit image input support.

Original tests are uploaded and run after execution finishes; the Agent does not receive tests or reference solutions during its attempt. The verifier preserves the original assertions and pytest arguments, moving installation steps from `test.sh` into environment preparation. `cancel-async-tasks` also retains the original test helper copy step.

When the model explicitly fails, the runner ends the attempt promptly and records an execution failure. Original grading runs separately only after processes stop and execution records close completely. Per-task verifierPackages are installed after the attempt, making those private dependencies unavailable while the Agent works.

The verifier can read task-installed Python dependencies, with pinned verifier packages taking priority. FEAL builds in a private verifier copy of the tests; Headless uses a private temporary root for its required paths. pytest caches go to writable logs. Displayed warnings are summarized; full output remains in `evidence/logs/verifier/output.txt`.

Explicitly public self-check helpers may have a separate read-only mount without exposing hidden tests. Path-tracing graders use a sealed workspace copy with `/app` and `/tmp` on one isolated mount. Chroot capability exists only inside the grader user namespace; system paths stay read-only. Startup checks pip entry points and required commands, and saves initializer output to `initializer.txt`. Terminal capture and web polling use approximately one-second intervals.

- `passed` / `failed`: the pytest exit code agrees with the current CTRF report, producing a valid score.
- Verifier timeout, startup failure, missing tests, or inconsistent reports: an infrastructure error with no valid score, not a fabricated zero.
- An execution timeout stops the Agent before grading; user cancellation skips grading. Execution and grading states are recorded separately.

```text
Host <data-dir>/
  config.json
  batches/<batch-id>.json
  runs/<run-id>/
    state.json / manifest.json
    task/ / task-files.json    Original task snapshot and hashes
    live/events.jsonl          Execution events
    live/screen.txt            Latest TUI screen
    preparation.log           Environment and execution diagnostics
    verification.txt          Test output summary (full output: evidence/logs/verifier/output.txt)
    evidence/                 Code, home directory, and logs
    collection.json           Export checksums
    evidence/outcome.json     Execution/grading facts before cleanup
    evidence/result.json      Final receipt after confirmed cleanup

Linux data volume: /eval/runs/<run-id>/
Linux source releases and dependencies: /opt/hicode/
```

Events and screens stream back continuously and are persisted incrementally. Full evidence is exported at completion, outside the live event loop, so collection cannot block verifier handoff. Abrupt machine shutdown can lose evidence not yet exported; retain the volume for inspection. Logs may contain source code, prompts, and tool output. Redact them before sharing.

Verifier handoff uses a dedicated request and atomic, run-scoped receipts: accepted, ready, or failed. The host acknowledges before uploading hidden tests. Acknowledgement has a 30-second deadline and the entire handoff has a 180-second deadline; cancellation ends the wait. Hidden tests are uploaded only after assignment processes have stopped.

Evidence records symlink targets without following them. Final export remains required before completion. Confirmed execution and grading facts survive an export failure, but no reward is published. The execution and grading panel shows failure summaries and collection diagnostics.

Closing the browser does not stop tasks. Ctrl+C in the service terminal cancels active tasks. `bash .devcontainer/linux.sh eval-stop` stops the evaluation machine while preserving its volume. Restarting the service does not resume or rerun attempted tasks. Unstarted tasks without execution evidence remain queued; other unfinished evidence blocks scheduling until inspected. After recovery, use `bash hicode-eval/eval.sh resume --batch BATCH_ID` to explicitly continue queued scheduling. This command does not clear errors or rerun completed tasks.

Cancel a batch with `bash hicode-eval/eval.sh cancel --batch BATCH_ID`. After completion, optionally ask Codex to inspect the logs. `report --batch BATCH_ID --file report.md` stores an external analysis only; it does not call a model or change grading.

If cleanup or collection leaves a task in `needs_recovery`, keep the service running and execute:

```bash
bash hicode-eval/eval.sh recover --run RUN_ID
```

Recovery checks task identity, runner termination, completion events, and grading evidence. It cleans up only that task's remaining processes, exports evidence again, and reconciles the original record without invoking the model, rerunning the verifier, or stopping other tasks. Missing or inconsistent evidence blocks recovery and preserves the scene. Repeated calls do not repeat the attempt; successful recovery resumes existing queued work. The prior state is saved as `state.before-recovery.json`, and the evidence receipt as `evidence/recovery.json`. The first Docker handoff acknowledgement allows up to 25 seconds, and host command timeouts report their actual deadline. After a Docker handoff or similar execution error, the service briefly waits for the original runner to persist its outcome. A verified outcome is reconciled automatically so queued work resumes; missing or inconsistent evidence remains in `needs_recovery` for inspection.

The viewer fits the window, with separate scrolling for the task list and terminal history. Resizing changes visible terminal rows without replaying output.

## Extending and validating

Others can reuse the CLI, TUI monitoring, automated grading, and evidence collection workflow. The runner currently targets HiCode; supporting another agent requires an execution adapter and completion events.

Before adding a task, review its initialization, dependencies, paths, and verifier, implement the adapter and offline tests, then register full file hashes. Do not merely add a task ID or remove original tests to obtain a passing result.

Each task has its own UID, home directory, and `/app` mount, but shares the system, network, and ports. This is a trusted local development environment, not a hosted isolation service for untrusted users. An adapter may declare pinned Python packages, which the runner installs only under that task’s `/app/.eval-python`; adding dependencies changes the task environment, so diagnostic scores must be kept separate from the upstream environment. Tasks requiring system configuration changes, global package installation, or special hardware are not currently supported.

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

The Python runner helpers use only the standard library; verifier dependencies live in the evaluation image. `web/vendor/` includes xterm.js under the MIT license; retain its license file. Keep run data, payloads, datasets, and credentials outside the repository and out of Git.

Evaluation assignments use `full-access` inside their own UID and outer read-only mount namespace, allowing workspace Git writes without interactive approvals. This does not change normal HiCode permissions. Control files are read-only, and assignment processes stop before original tests are uploaded and executed. The outer boundary continues to protect system paths and other assignments.

Pre-download pinned Python wheels and their dependencies into `/opt/hicode-eval/wheels/<package>-<version>/` on the evaluation machine. When these directories exist, the runner installs offline with `--no-index` into the task directory; an incomplete cache fails without network fallback. Agent and verifier versions are installed separately.

Prompt pasting and Enter are sent separately. Execution and the agent budget begin only after `model_stream_start`; a submission with no acknowledgment within 15 seconds fails as a startup error instead of idling through the task budget.

At the evaluation deadline, the runner sends SIGTERM to the identified HiCode CLI and allows up to 10 seconds for cancellation and persistence while draining events, then force-cleans remaining processes for that task UID. This window is for teardown, not continued solving: execution remains timeout even if grading passes. `evidence/shutdown.json` records CLI exit, saved-turn status, and pending tool calls; missing events are never fabricated.

## Additional public datasets

Terminal-Bench and SWE-bench Verified share scheduling, task budgets, the TUI, cancellation and evidence collection. Dataset-specific adapters prepare inputs and grade outputs. `Run.dataset` identifies the adapter; legacy runs remain Terminal tasks. Both datasets can appear in one batch.

Two new Terminal tasks are registered: `large-scale-text-editing` and `break-filter-js-from-html`. CSV generation/removal/reset follows the upstream task, while browser grading retains Chromium/driver and separate pinned actor/verifier packages. Prepare their shared tools and wheel caches once on an idle dedicated machine:

```bash
bash hicode-eval/eval.sh prepare-terminal --docker-context YOUR_CONTEXT --machine YOUR_EVAL_MACHINE
```

SWE preparation supports Django 3.2/Python 3.6, Django 4.0/Python 3.8, Django 4.1/4.2/Python 3.9, Django 5.0/Python 3.11, and SymPy 1.0, 1.1, 1.4-1.12/Python 3.9, Pytest 5.0-5.2/5.4/6.0/6.2/7.2/Python 3.9, and Xarray 0.12/2022.03/2022.06/2022.09/Python 3.10, and Sphinx 3.1-3.5/4.0-4.3/5.0-5.2/7.1/7.2/Python 3.9, selected with `--ids`. It verifies the fixed Verified revision, public/evaluator JSONL hashes, corresponding public fields, the official harness 4.1.0 wheel, and each supported environment recipe. Django requirements are checked against the original file; SymPy uses its original declared package list. Pytest and Xarray use reviewed official recipe hashes; Xarray also checks the original environment.yml hash and installs reviewed dependencies and declared build backends. Sphinx replays the reviewed upstream tox/dependency adjustments, caches test extras by public packaging declarations, and collects one original public test module during preflight without running hidden assertions. Preparation inputs and generated bundles stay outside this repository:

```bash
bash hicode-eval/eval.sh prepare-swe \
  --dataset /path/to/swe-bench-verified \
  --prep /path/to/benchmark-prep/swe_verified \
  --output /path/to/external/prepared-swe \
  --docker-context YOUR_CONTEXT --machine YOUR_EVAL_MACHINE
```

Preparation requires an idle evaluation machine and network access. Python, the official harness and declared dependencies are cached per repository, version and environment group; each task receives its own copied environment, including mixed-version batches. Each task gets the source archive for its exact base commit and a local repository containing only that source tree and its installation baseline. No future Git history, remotes or hooks are retained. Resolved package versions are copied into `runs/ID/environment.json` when an attempt starts. Failed preparation retains caches; the output directory must be a new external directory.

Add `--swe-tasks /path/to/external/prepared-swe` to the normal service command. Reuse the same dashboard and machine; do not start another service or prepare system dependencies during active attempts. Submit `config/swe-verified-pilot.json`, or mix the selected SWE and Terminal IDs in a batch.

Both preparation commands accept `--ids ID1,ID2`. Django bundles pin development checkers from the source `.pre-commit-config.yaml`; SymPy uses the declared development packages. Separate caches preserve previous attempts. Preparation makes no model calls and does not establish a passing score.

The Actor receives only the public problem, original base code and public repository tests, with an independent writable Python environment at `/testbed`. Gold patches, hints, hidden test patches and scoring test lists are withheld. After completion/timeout, stop every Actor process, then export the actual tree against a protected prepared baseline using host-owned Git. This includes additions, deletions, binaries and executable modes without trusting Actor-controlled Git state or self-reported patches.

Save the official prediction fields in `prediction.json` and identity/hash receipts in `patch-manifest.json`. Replay that patch against clean code, dependencies and Home; only then expose hidden test material. Use upstream harness 4.1.0 repository-specific commands, log parsing and both FAIL_TO_PASS/PASS_TO_PASS rules. Keep `logs/verifier/output.txt` and `report.json`; no synthetic CTRF reports are produced. Incomplete grading is `unavailable`; genuine test failures are `failed`. Recovery validates existing evidence without rerunning anything.

This is **shared Linux development evaluation**, using venv instead of upstream Conda/instance images and recreating a Git baseline from the source archive. Environment activation and test-file reset commits are adapted accordingly; tests, assertions and grading rules stay upstream. These results are not official image/leaderboard reproductions. Supported repositories and versions are listed above and enforced by production validation. Each selected environment group still requires preparation and namespace preflight while the machine is idle; a task ID alone does not establish readiness.

Preparation resolves original requirements from external `environment-groups.json` by repository, version and environment setup commit. Mixed selections prepare each group separately; caches include version, setup commit, dependency content and architecture. Development-tool pins come only from each base tree’s actual pre-commit declarations. Preparation requires no active evaluation tasks.


### Task isolation and environment readiness

The Actor has a private filesystem root with explicit system/runtime mounts. Its event export is `actor-events/events.jsonl`; terminal capture and grading logs stay outside its view. The submitted prompt reports the exact resolved per-task time limit and actual public test paths, and claims no internet only for isolated runs.

HiCode `shutdown` is accepted as a saved cancellation reason while execution timeouts remain timeouts; event pairing, persistence and CLI exit checks still apply.

Xarray preparation includes pinned CPU regression dependencies from the verified version declarations, genuine upstream SCM version metadata and per-task public regression preflight. Actor and grader reuse the same prepared environment. Tasks with missing, skipped or failing required public regressions are refused before a model starts. Old 0.12 source trees use compatible Pandas 1.3.5; unavailable CDAT dependencies remain a preparation blocker, never a passing skip. Only two verified non-strict ARM datetime XPASS results get faithful PASSED reporting; other XPASS and skipped results are unchanged. Historical scores are not rewritten. See the current [reference](../docs/reference/HICODE-EVAL.md) for boundaries and receipts.
