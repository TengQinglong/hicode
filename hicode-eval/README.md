# HiCode Eval

[English](README.en.md)

在一台长期运行的 Linux 容器中，批量测试 HiCode 完成公开编程任务的能力。CLI 提交任务，网页查看完整 TUI 和进度，结束后自动运行原题测试并保存日志。每题独立尝试一次，不追加纠错提示、不自动重跑。

目前适配 Terminal-Bench 2.0 的 **6 道题**：`cancel-async-tasks`、`log-summary-date-ranges`、`regex-log`、`sqlite-db-truncate`、`code-from-image`、`constraints-scheduling`。其余 83 题仍需逐题适配，不能直接提交。此工具用于研发回归；共享系统、ARM64 环境和可调时限与官方环境存在差异，结果不等同于官方榜单成绩。

## 1. 准备环境与数据

以下命令从 **HiCode 仓库根目录**执行。宿主需要 Git、Bun 1.3+、Python 3.9+ 和 Docker CLI。Mac 上先按 [开发容器说明](../.devcontainer/README.md) 安装 Colima、Compose 和 Buildx，并创建 `hicode` 虚拟机。原生 Linux 可使用自己的 Docker context，但需准备同样的嵌套沙箱策略，详见该文档。

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh eval-start
```

首次会构建开发基础镜像及独立评测镜像，安装 tmux、Python 3.13、pytest 8.4.1 和 pytest-json-ctrf 0.3.5。之后复用镜像，不为每题重新安装。评测机名为 `hicode-eval-linux`，只挂独立数据卷，不挂宿主源码、Home 或 Docker socket；开发容器不必同时运行。

将上游题目下载到仓库外，并固定为已审核版本：

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`public-tasks.json` 校验已接入题目的完整文件哈希，题目变更后会拒绝执行。仓库不附带题目或参考解；使用数据集须遵守上游许可与使用条件。无需安装 Harbor。

## 2. 配置模型并固定源码

运行 `bun run start`，用 `/providers` 配置连接、Key 和模型，再用 `/model` 选择默认模型，完成后退出。评测服务读取 **本仓库及用户 `~/.hicode`** 的设置；不读取题目目录或其他项目的模型配置。

也可以复制 [model.example.json](model.example.json) 为 `hicode-eval/model.local.json`，填写模型 ID、接口地址和 Key 的环境变量名，启动时传 `--model-config hicode-eval/model.local.json`。此 JSON **不存 Key 值**。Key 从进程环境、本仓库 `.env`、`~/.hicode/.env` 依次补缺；可通过 `/providers` 保存，无需把凭据写进命令行。`source` 目前支持 `qwen`、`deepseek`、`glm`、`openrouter`。

冻结待测版本：

```bash
bash hicode-eval/eval.sh prepare --payload ../hicode-eval-data/payload-v1
```

默认要求工作区干净。测试未提交代码时追加 `--snapshot-worktree`，仅纳入 `src/`、`package.json`、`bun.lock` 和 `tsconfig.json` 的修改。payload 只包含这些运行输入，记录提交号、覆盖文件及归档哈希；每个新版本使用新的输出目录。

## 3. 启动与提交

```bash
bash hicode-eval/eval.sh serve \
  --data-dir ../hicode-eval-data/runs \
  --tasks ../terminal-bench-2 \
  --payload ../hicode-eval-data/payload-v1 \
  --docker-context colima-hicode \
  --machine hicode-eval-linux \
  --concurrency 3
```

服务先部署固定源码，依赖未变时复用生产依赖，否则只在此阶段安装一次。出现服务地址后打开 **http://127.0.0.1:8878**。网页只负责查看；保留服务终端，在另一个终端提交：

```bash
bash hicode-eval/eval.sh catalog
bash hicode-eval/eval.sh submit --file hicode-eval/batch.example.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

将 `BATCH_ID` 替换为提交返回的 ID。示例批次包含上述 6 题，并发 3、每题 30 分钟。修改批次文件的 `tasks`、`concurrency`、`budget.agentSeconds` 即可调整；并发最多 3，不能超过服务上限；时限为 30–7200 秒。实际预算和原题预算均会记录，加长时限属于研发评测条件。

`--source` 和 `--model` 可成对覆盖已配置模型；自定义连接使用 `--model-config`。更换端口时，所有 CLI 命令都传同一个 `--port`。同一评测机只运行一个服务，不在任务期间部署另一个版本。

CLI 可由人或 Codex 等工具操作，**不依赖 Codex 做调度或判题**。真实任务调用配置的模型并产生费用，离线测试不调用模型。

## 判题、日志与停止

新增题目的数据库、图片和日历按 `public-tasks.json` 中的 `inputs` 清单精确复制并校验哈希，不复制整个题目目录。图片题需要模型显式支持图片输入。

执行完成后自动上传原题测试并判题；执行期间不向 Agent 提供测试或参考解。使用原测试断言及 pytest 参数，把原 `test.sh` 的安装步骤移到环境准备阶段。`cancel-async-tasks` 还保留原测试辅助文件的复制步骤。

- `passed` / `failed`：pytest 退出码与本次 CTRF 报告一致，生成有效判分。
- 判题超时、启动失败、未收集到测试或报告不一致：记为异常，无有效判分，不伪造 0 分。
- 执行超时先停止 Agent 再验收；用户取消不判题。执行状态与判题状态分别保存。

```text
宿主 <data-dir>/
  config.json
  batches/<batch-id>.json
  runs/<run-id>/
    state.json / manifest.json
    task/ / task-files.json    原题快照与哈希
    live/events.jsonl          执行事件
    live/screen.txt            最新 TUI 画面
    preparation.log           环境及执行诊断
    verification.txt          原题测试输出
    evidence/                 代码、Home、日志等现场
    collection.json           导出校验记录
    evidence/outcome.json     清理前保存的执行/判题事实
    evidence/result.json      清理确认后的最终回执

Linux 数据卷：/eval/runs/<run-id>/
Linux 运行版本与依赖：/opt/hicode/
```

事件与画面持续传回，完整现场每 30 秒尝试复制到宿主，结束时再次收集。突然关闭机器可能丢失尚未导出的内容；保留数据卷检查。日志可能含源码、提示词和工具输出，分享前需脱敏。

关闭网页不影响任务。Ctrl+C 关闭评测服务会取消当前任务；`bash .devcontainer/linux.sh eval-stop` 停止整台评测机，保留数据卷。服务重启不自动重跑或接续已执行的题；从未启动且无执行痕迹的题保留排队，发现其他未完成现场会停止新调度，需先核查现场。确认异常任务已收尾后，可用 `bash hicode-eval/eval.sh resume --batch BATCH_ID` 显式恢复现有排队调度；此命令不清除异常、不重跑已完成题。

取消指定批次：`bash hicode-eval/eval.sh cancel --batch BATCH_ID`。跑完后可让 Codex 读取日志做复盘；可选的 `report --batch BATCH_ID --file report.md` 仅保存人工或外部分析，不调用模型、不改判分。

若任务因清理或收集失败停在 `needs_recovery`，保持服务运行后执行：

```bash
bash hicode-eval/eval.sh recover --run RUN_ID
```

恢复会核验任务身份、原进程已退出、完成事件和判题证据，只清理该题残留进程，重新导出现场并更新原记录；不调用模型、不重新判题、不停止其他题。证据不足或不一致时拒绝恢复并保留现场。重复执行不会重复做题；恢复成功后继续调度已有队列。恢复前状态保存为 `state.before-recovery.json`，核验回执保存为 `evidence/recovery.json`。

网页固定在当前窗口内，任务列表与终端历史分别滚动；调整窗口高度会改变终端可见行数，不会重播输出。

## 扩充题目与开发验证

其他人可以复用这套 CLI、TUI 观察、自动验收和证据收集流程。目前运行器面向 HiCode；接其他 Agent 需要实现相应执行和完成事件适配。

新增题目需审核原始初始化、依赖、路径和判题脚本，补齐 runner 适配与离线测试，再登记完整哈希。不要仅添加题目 ID 或删除原测试来获得通过结果。

任务各有独立 UID、Home 和 `/app` 挂载，但共享系统、网络和端口；这是可信的本地研发环境，不是面向陌生用户的安全隔离服务。当前不接要求修改系统配置、全局安装依赖或特殊硬件的题。

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/container python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

Python 调度辅助代码只用标准库；验收依赖安装在评测镜像中。`web/vendor/` 包含带 MIT 许可的 xterm.js，保留其许可证。运行数据、payload、数据集和凭据放在仓库外，不提交到 Git。
