# HiCode Eval

[简体中文](README.md)

Run public programming tasks through HiCode on a persistent Linux container. Submit batches from the CLI, watch the full TUI in a browser, and automatically collect test results and logs. Each task gets one independent attempt, with no corrective follow-up prompts or automatic retries.

Currently supports **6 Terminal-Bench 2.0 tasks**: `cancel-async-tasks`, `log-summary-date-ranges`, `regex-log`, `sqlite-db-truncate`, `code-from-image`, and `constraints-scheduling`. The remaining 83 tasks require individual adaptation and cannot be submitted yet. This is a development regression tool: the shared system, ARM64 environment, and configurable time limits differ from official benchmark conditions. Results are not official leaderboard scores.

## 1. Prepare the environment and dataset

Run these commands from the **HiCode repository root**. The host needs Git, Bun 1.3+, Python 3.9+, and the Docker CLI. On macOS, first follow the [development container guide](../.devcontainer/README.en.md) to install Colima, Compose, and Buildx and create the `hicode` VM. Native Linux can use another Docker context, but requires the equivalent nested sandbox policy described in that guide.

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh eval-start
```

The first run builds the development base and a dedicated evaluation image with tmux, Python 3.13, pytest 8.4.1, and pytest-json-ctrf 0.3.5. Subsequent runs reuse the image; nothing is installed per task. The `hicode-eval-linux` container mounts only a dedicated data volume, without your checkout, home directory, or Docker socket. The development container does not need to be running.

Download the dataset outside this repository and pin the reviewed revision:

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`public-tasks.json` verifies the full file hashes of supported tasks and rejects modified versions. Tasks and reference solutions are not distributed in this repository; follow the upstream dataset's license and usage conditions. Harbor is not required.

## 2. Configure a model and freeze the source

Run `bun run start`, configure a connection, API key, and model with `/providers`, select the default with `/model`, then exit. The evaluation service reads settings from **this checkout and `~/.hicode`**, not from task directories or another project.

Alternatively, copy [model.example.json](model.example.json) to `hicode-eval/model.local.json`, fill in the model ID, endpoint, and API key environment variable name, and pass `--model-config hicode-eval/model.local.json` to `serve`. The JSON **does not contain the API key value**. Credentials are resolved from the process environment, this checkout's `.env`, then `~/.hicode/.env`; `/providers` can save them without putting a key in command-line arguments. Supported `source` values are `qwen`, `deepseek`, `glm`, and `openrouter`.

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
bash hicode-eval/eval.sh submit --file hicode-eval/batch.example.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

Replace `BATCH_ID` with the ID returned on submission. The example runs all six supported tasks, with concurrency 3 and 30 minutes per task. Adjust `tasks`, `concurrency`, and `budget.agentSeconds` in the batch file as needed. Concurrency is capped at 3 and cannot exceed the service limit; task budgets range from 30 to 7200 seconds. Actual and original task budgets are recorded separately; extended budgets are development evaluation conditions.

Use `--source` and `--model` together to override a configured model, or `--model-config` for an explicit connection. If changing the port, pass the same `--port` to every CLI command. Run only one service per evaluation machine, and do not deploy another version while tasks are active.

A person or an agent such as Codex can operate the CLI. **Scheduling and grading do not depend on Codex.** Real tasks incur usage charges from your configured model provider; offline tests do not call a model.

## Grading, logs, and shutdown

Database, image, and calendar inputs are copied individually from the reviewed `inputs` manifest in `public-tasks.json` and verified by hash, rather than copying the entire task directory. The image task requires a model with explicit image input support.

Original tests are uploaded and run after execution finishes; the Agent does not receive tests or reference solutions during its attempt. The verifier preserves the original assertions and pytest arguments, moving installation steps from `test.sh` into environment preparation. `cancel-async-tasks` also retains the original test helper copy step.

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
    verification.txt          Original test output
    evidence/                 Code, home directory, and logs
    collection.json           Export checksums
    evidence/outcome.json     Execution/grading facts before cleanup
    evidence/result.json      Final receipt after confirmed cleanup

Linux data volume: /eval/runs/<run-id>/
Linux source releases and dependencies: /opt/hicode/
```

Events and screens stream back continuously; full evidence collection is attempted every 30 seconds and again at completion. Abrupt machine shutdown can lose evidence not yet exported; retain the volume for inspection. Logs may contain source code, prompts, and tool output. Redact them before sharing.

Closing the browser does not stop tasks. Ctrl+C in the service terminal cancels active tasks. `bash .devcontainer/linux.sh eval-stop` stops the evaluation machine while preserving its volume. Restarting the service does not resume or rerun attempted tasks. Unstarted tasks without execution evidence remain queued; other unfinished evidence blocks scheduling until inspected. After recovery, use `bash hicode-eval/eval.sh resume --batch BATCH_ID` to explicitly continue queued scheduling. This command does not clear errors or rerun completed tasks.

Cancel a batch with `bash hicode-eval/eval.sh cancel --batch BATCH_ID`. After completion, optionally ask Codex to inspect the logs. `report --batch BATCH_ID --file report.md` stores an external analysis only; it does not call a model or change grading.

If cleanup or collection leaves a task in `needs_recovery`, keep the service running and execute:

```bash
bash hicode-eval/eval.sh recover --run RUN_ID
```

Recovery checks task identity, runner termination, completion events, and grading evidence. It cleans up only that task's remaining processes, exports evidence again, and reconciles the original record without invoking the model, rerunning the verifier, or stopping other tasks. Missing or inconsistent evidence blocks recovery and preserves the scene. Repeated calls do not repeat the attempt; successful recovery resumes existing queued work. The prior state is saved as `state.before-recovery.json`, and the evidence receipt as `evidence/recovery.json`.

The viewer fits the window, with separate scrolling for the task list and terminal history. Resizing changes visible terminal rows without replaying output.

## Extending and validating

Others can reuse the CLI, TUI monitoring, automated grading, and evidence collection workflow. The runner currently targets HiCode; supporting another agent requires an execution adapter and completion events.

Before adding a task, review its initialization, dependencies, paths, and verifier, implement the adapter and offline tests, then register full file hashes. Do not merely add a task ID or remove original tests to obtain a passing result.

Each task has its own UID, home directory, and `/app` mount, but shares the system, network, and ports. This is a trusted local development environment, not a hosted isolation service for untrusted users. An adapter may declare pinned Python packages, which the runner installs only under that task’s `/app/.eval-python`; adding dependencies changes the task environment, so diagnostic scores must be kept separate from the upstream environment. Tasks requiring system configuration changes, global package installation, or special hardware are not currently supported.

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/container python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

The Python runner helpers use only the standard library; verifier dependencies live in the evaluation image. `web/vendor/` includes xterm.js under the MIT license; retain its license file. Keep run data, payloads, datasets, and credentials outside the repository and out of Git.
