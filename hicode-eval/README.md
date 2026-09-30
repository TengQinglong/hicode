# HiCode Eval

[English](README.en.md)

在一台长期运行的 Linux 容器中，批量测试 HiCode 完成公开编程任务的能力。CLI 提交任务，网页查看完整 TUI 和进度，结束后自动运行原题测试并保存日志。每题独立尝试一次，不追加纠错提示、不自动重跑。

已适配题目见 [题目清单](config/terminal-bench.json)。此工具用于研发回归；共享系统、ARM64 环境和可调时限与官方环境存在差异，结果不等同于官方榜单成绩。

批次执行状态与成绩由 CLI `status` 查询。个人题目复盘和环境准备记录保存在仓库外。

## 目录与记录

```text
src/
  cli.ts     命令行入口
  host/      宿主调度、状态、Linux 连接与源码打包
  worker/    Linux 执行、判题、终端记录与收尾
  web/       只读看板与终端组件
config/      题目适配清单、固定回归题组与配置示例
tests/       离线回归测试
skills/      Codex 批量评测操作说明
```

题目文件、源码 payload、凭据和运行记录保存在仓库外。`config/` 只保存通用声明、固定回归题组和示例；每次实际提交的模型、版本、预算和结果，以 `<data-dir>/batches/` 与 `runs/` 为准。临时选题配置放在仓库外，例如 `../hicode-eval-data/batch-configs/`，不存入源码目录。个人状态与本机准备记录可放在 `../hicode-eval-data/records/`。

## 1. 准备环境与数据

以下命令从 **HiCode 仓库根目录**执行。宿主需要 Git、Bun 1.3+、Python 3.9+ 和 Docker CLI。Mac 上先按 [开发容器说明](../.devcontainer/README.md) 安装 Colima、Compose 和 Buildx，并创建 `hicode` 虚拟机。原生 Linux 可使用自己的 Docker context，但需准备同样的嵌套沙箱策略，详见该文档。

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh eval-start
```

首次会构建开发基础镜像及独立评测镜像，安装 tmux、Python 3.13、pytest 8.4.1 和 pytest-json-ctrf 0.3.5。之后复用镜像和系统工具；题目专属 Python 依赖按清单安装到独立目录。评测机名为 `hicode-eval-linux`，只挂独立数据卷，不挂宿主源码、Home 或 Docker socket；开发容器不必同时运行。

将上游题目下载到仓库外，并固定为已审核版本：

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`config/terminal-bench.json` 校验已接入题目的完整文件哈希，题目变更后会拒绝执行。仓库不附带题目或参考解；使用数据集须遵守上游许可与使用条件。无需安装 Harbor。

## 2. 配置模型并固定源码

运行 `bun run start`，用 `/providers` 配置连接、Key 和模型，再用 `/model` 选择默认模型，完成后退出。评测服务读取 **本仓库及用户 `~/.hicode`** 的设置；不读取题目目录或其他项目的模型配置。

也可以复制 [config/example.model.json](config/example.model.json) 为 `../hicode-eval-data/model.local.json`，填写模型 ID、接口地址和 Key 的环境变量名，启动时传 `--model-config ../hicode-eval-data/model.local.json`。此 JSON **不存 Key 值**。Key 从进程环境、本仓库 `.env`、`~/.hicode/.env` 依次补缺；可通过 `/providers` 保存，无需把凭据写进命令行。`source` 目前支持 `qwen`、`deepseek`、`glm`、`openrouter`。

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
bash hicode-eval/eval.sh submit --file hicode-eval/config/example.batch.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

将 `BATCH_ID` 替换为提交返回的 ID。同一批次可以混合不同执行时限，任务用 `id` 和可选的 `agentSeconds` 声明：

```json
{
  "name": "本轮测试",
  "tasks": [
    { "id": "cancel-async-tasks", "agentSeconds": 900 },
    { "id": "log-summary-date-ranges", "agentSeconds": 1800 }
  ],
  "concurrency": 3
}
```

省略某题的 `agentSeconds` 时使用服务默认值（1800 秒）；每题可设置 30–7200 秒。并发最多 4，不能超过服务上限。页面逐题显示时限，运行结束后自动补位。实际预算和原题预算均会记录，加长时限属于研发评测条件。固定 15 道回归配置见 [regression15.json](config/regression15.json)。

`--source` 和 `--model` 可成对覆盖已配置模型；自定义连接使用 `--model-config`。更换端口时，所有 CLI 命令都传同一个 `--port`。同一评测机只运行一个服务，不在任务期间部署另一个版本。

CLI 可由人或 Codex 等工具操作，**不依赖 Codex 做调度或判题**。真实任务调用配置的模型并产生费用，离线测试不调用模型。

## 判题、日志与停止

新增题目的数据库、图片和日历按 `config/terminal-bench.json` 中的 `inputs` 清单精确复制并校验哈希，不复制整个题目目录。图片题需要模型显式支持图片输入。

执行完成后自动上传原题测试并判题；执行期间不向 Agent 提供测试或参考解。使用原测试断言及 pytest 参数，把原 `test.sh` 的安装步骤移到环境准备阶段。`cancel-async-tasks` 还保留原测试辅助文件的复制步骤。

判题能读取该题安装的 Python 依赖，固定判题版本优先。FEAL 的编译只写入判题专用测试副本；Headless 所需的根目录路径使用判题进程的临时根目录。pytest 缓存写入可写日志目录，警告在展示中汇总，完整输出保留在 `evidence/logs/verifier/output.txt`。

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
    verification.txt          原题测试输出摘要（完整输出见 evidence/logs/verifier/output.txt）
    evidence/                 代码、Home、日志等现场
    collection.json           导出校验记录
    evidence/outcome.json     清理前保存的执行/判题事实
    evidence/result.json      清理确认后的最终回执

Linux 数据卷：/eval/runs/<run-id>/
Linux 运行版本与依赖：/opt/hicode/
```

事件与画面持续传回，完整现场每 30 秒尝试复制到宿主，结束时再次收集。突然关闭机器可能丢失尚未导出的内容；保留数据卷检查。日志可能含源码、提示词和工具输出，分享前需脱敏。

证据快照记录符号链接目标，不跟随链接。周期收集失败写入 `collection-error.txt`，不打断答题；最终导出仍须成功才能提交终态。 导出失败时保留已经确认的执行／判题事实，但不发布分数；页面的执行与判题记录面板可查看失败摘要和采集诊断。

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

任务各有独立 UID、Home 和 `/app` 挂载，但共享系统、网络和端口；这是可信的本地研发环境，不是面向陌生用户的安全隔离服务。任务清单可声明固定版本的 Python 包，runner 只装进该题的 `/app/.eval-python`；增加依赖会改变该题环境，诊断分数须与原始环境分开记录。当前不接要求修改系统配置、全局安装依赖或特殊硬件的题。

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

Python 调度辅助代码只用标准库；验收依赖安装在评测镜像中。`web/vendor/` 包含带 MIT 许可的 xterm.js，保留其许可证。运行数据、payload、数据集和凭据放在仓库外，不提交到 Git。

评测任务在独立 UID 与外层只读挂载隔离内使用 `full-access`，允许题目工作区的 Git 写操作，无需人工审批；这不改变日常 HiCode 的权限。控制目录只读，任务进程全部停止后才上传并运行原题测试。宿主系统、其他任务仍受外层隔离保护。

固定版本 Python 包可提前下载到评测机 `/opt/hicode-eval/wheels/<包名>-<版本>/`（包含其依赖的 wheel）。存在对应目录时，runner 使用 `--no-index` 离线安装到该题目录；缓存不完整直接报错，不偷偷联网。做题与判题版本分别安装。

题面粘贴与提交分开发送，收到 Agent 的 `model_stream_start` 才确认执行并开始计时。提交后 15 秒无确认会标记启动异常，不消耗整题时限空等。

评测到时先向已确认身份的 HiCode 主进程发送 SIGTERM，最多等待 10 秒收尾，持续收集工具结果和日志，然后清理该题 UID 的残留进程。收尾窗口不用于继续答题，执行状态仍为 timeout；判题通过也不改为 completed。`evidence/shutdown.json` 记录进程是否退出、Turn 是否保存和未闭合的工具调用；强制清理时不伪造缺失事件。

## 接入新的公开数据集

Terminal-Bench 和 SWE-bench Verified 共用批次、并发、每题时限、TUI、取消和证据收集；输入准备及判题按数据集分别执行。`Run.dataset` 区分两种题目，旧运行记录仍按 Terminal 读取。一个批次可以包含两种题目。

新增 Terminal 题 `large-scale-text-editing` 和 `break-filter-js-from-html` 使用已审核的原题文件哈希。前者做题前生成原始 input/expected CSV 并删除生成器，判题前删除 CSV、用隐藏的原生成器只重建 input；后者仅提供原 Dockerfile 明确公开的文件，使用匹配的 Chromium/driver 和分别固定的做题、判题包版本。共享工具和 wheel 缓存只准备一次，模型尝试前缺少工具会报告环境错误：

```bash
bash hicode-eval/eval.sh prepare-terminal --docker-context YOUR_CONTEXT --machine YOUR_EVAL_MACHINE
```

SWE 首批支持 Django 4.2/Python 3.9 的四道 Verified 题。准备入口核对固定数据 revision、公开/判题 JSONL 的哈希及对应字段，使用准备包里的官方 harness 4.1.0 wheel 和原 requirements。准备包作为外部输入，不复制或提交到此仓库：

```bash
bash hicode-eval/eval.sh prepare-swe \
  --dataset /path/to/swe-bench-verified \
  --prep /path/to/benchmark-prep/swe_verified \
  --output /path/to/external/prepared-swe \
  --docker-context YOUR_CONTEXT --machine YOUR_EVAL_MACHINE
```

准备需要空闲的专用评测机和网络。首次下载 Python 3.9、官方 harness 及 Django 原声明的全部依赖，包括原生扩展所需的系统头文件；后续缓存复用。输出目录必须是新的仓库外目录，失败缓存保留供检查。每题下载指定 base commit 的 GitHub 源码归档，建立仅含原始树和安装基线的本地 Git 仓库，不保留远端、未来历史或 hook。环境实际解析版本记录在机器缓存的 `.ready.json`，运行时复制到宿主 `runs/ID/environment.json`。

服务启动时在原有参数上增加 `--swe-tasks /path/to/external/prepared-swe`。复用同一个看板和专用机器；活动任务运行时不要另起服务或重新准备系统依赖。四题可用 `config/swe-verified-pilot.json` 提交，也可在同一批次加入 Terminal 题。

SWE 的隔离与评分契约：

- Agent 仅收到原始题面、指定 base code、仓库自带公开测试和各题独立的 Python 环境，工作目录 `/testbed`。不提供 gold patch、hints、隐藏 test patch 或评分测试名单。
- Agent 结束或超时后先停止该题所有进程，再由宿主读取实际文件，以受保护的安装基线导出新增、修改、删除、二进制及可执行位变化。忽略 Agent 控制的 Git/index/hooks，不采信模型自报补丁。
- `prediction.json` 使用官方 `instance_id`、`model_name_or_path`、`model_patch` 字段；`patch-manifest.json` 记录原 base commit、安装基线 commit、数据 revision 和补丁哈希。
- 在干净代码、独立依赖和新 Home 中重放补丁，原 hidden test patch 仅此时进入判题视图。使用官方 4.1.0 的 Django 测试命令、日志解析和 FAIL_TO_PASS/PASS_TO_PASS 评分；保存原始 `logs/verifier/output.txt` 和 `report.json`，不转换成虚构的 CTRF。
- 无完整测试输出、初始化失败或判题超时记为 `unavailable`，不误判模型错误；官方回归测试未通过记为 `failed`。恢复只核验已有报告和补丁哈希，不重跑 Agent 或判题。

这是 **共享 Linux 研发评测**：使用 venv 替代官方 Conda/实例镜像、从源码归档重建 Git 基线，官方脚本的环境激活及测试文件 reset commit 随之适配，测试、断言和评分规则不变。不能把这些结果表述为官方镜像下的榜单复现。目前仅接入上述 Django 环境组；其他仓库需新增对应环境配方后再登记。
