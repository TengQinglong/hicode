# 当前 CLI 与证据入口

先解析 Skill 目录的 realpath，再向上定位包含 `hicode-eval/src/cli.ts` 的 checkout。先核对现有服务；不要把技能安装目录当 checkout。维护契约以该 checkout 的 `hicode-eval/README.md`、`src/host/types.ts` 和 CLI 为准；只有命令不确定或实现变更时再查它们。

## 路径与复用

在当前工具调用中显式填写 `HE_ROOT`（checkout）、`HE_DATA`（仓库外数据根）、`HE_TASKS`（固定数据集）、`HE_PAYLOAD`（固定源码包）、`HE_PORT` 和 `HE_BATCH_FILE`。变量不会自动跨工具调用保存。通用配置在 `hicode-eval/config/`；临时提交文件放在外部数据目录的 `batch-configs/`，不要存回源码目录。固定回归题组可以复用 `config/regression15.json`，不要误将示例题目当作用户选题。

现有数据根的 `config.json` 记录真实 tasks/payload/model/concurrency；`.service.lock/owner.json` 记录 PID/启动身份。结合监听进程和 status 核对，不能只凭旧 owner 文件杀进程。模型凭据不打印、不复制到任务文件。

服务和 batch 都限制并发，实际运行受两者共同约束。只读核对后能复用就直接提交，不再次运行 prepare/安装依赖/全量测试。payload 的 manifest 记录 commit、overlay 和归档 hash；仅必要时冻结新版本，不能默认把未提交源码装进被测版本。

## 常用命令

从 checkout 根目录执行；同一服务的命令使用同一个端口：

```bash
bash hicode-eval/eval.sh catalog --port "$HE_PORT"
bash hicode-eval/eval.sh submit --file "$HE_BATCH_FILE" --port "$HE_PORT"
bash hicode-eval/eval.sh status --batch "$HE_BATCH" --port "$HE_PORT"
bash hicode-eval/eval.sh wait --batch "$HE_BATCH" --wait-seconds 30 --port "$HE_PORT"
```

status/wait 输出含完整任务清单，接收后只打印批次 state/counts、run 的 task/state/execution/grading/collection/note 和 schedulingBlocked；不要把完整 JSON 灌进上下文再重读。需要时通过现有 `src/host/client.ts` 的 `Client.status()` 读取并投影，不为单次检查编写新的监控系统。

先用 `bash hicode-eval/eval.sh --help` 确认入口；路径变更后的离线检查用 `bun test hicode-eval/tests`，Python 用 `PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker python3 -B -m unittest discover -s hicode-eval/tests`。正常启动已有环境不重复运行这些开发验证。

批次 JSON 只有 `name`、`tasks`（`{id, agentSeconds}` 对象数组）与 `concurrency`（1–5）。`agentSeconds` 是每题时限，范围 30–7200 秒，省略使用服务默认 1800 秒；没有批次级 budget 参数。同一轮的不同预算放进同一个批次，不再按时间分组。配置示例：`{"name":"本轮","tasks":[{"id":"polyglot-c-py","agentSeconds":900},{"id":"modernize-scientific-stack","agentSeconds":600}],"concurrency":3}`。以已保存的用户约定为准，不直接运行示例文件中的题目。

只有服务不存在或已空闲且配置确需更新时启动/重启；任务运行中不能使用这条命令另开同机服务：

```bash
bash hicode-eval/eval.sh serve \
  --data-dir "$HE_DATA" --tasks "$HE_TASKS" --payload "$HE_PAYLOAD" \
  --docker-context "$HE_CONTEXT" --machine "$HE_MACHINE" \
  --concurrency "$HE_CONCURRENCY" --port "$HE_PORT"
```

默认由服务解析用户现有模型；显式覆盖才使用 `--source/--model` 或 `--model-config`。复用宿主可保留的工具会话运行服务。

恢复只处理已有现场，不重新做题：

```bash
bash hicode-eval/eval.sh recover --run "$HE_RUN" --port "$HE_PORT"
bash hicode-eval/eval.sh resume --batch "$HE_BATCH" --port "$HE_PORT"
```

recover 用于 needs_recovery，证据不足会拒绝；resume 只恢复既有未启动队列，不能重跑完成或已取消批次。`cancel --batch` 会取消整批，不能拿它处理单题问题。发布已完成批次分析可用 `report --batch ID --file FILE`，不会调用模型。

## 证据

相对 `HE_DATA`：

| 入口 | 用途 |
| --- | --- |
| `batches/ID.json` | 固定版本、模型、题目、预算、run IDs |
| `runs/ID/state.json` | 执行/判题/收集状态与时间 |
| `runs/ID/preparation.log` | 初始化和依赖诊断 |
| `runs/ID/live/screen.txt` | 最近 TUI，不能仅据画面静止判断停止 |
| `runs/ID/live/events.jsonl` | 有序事件；外层 at 为毫秒，agent_event 的内层 event 含工具与模型事件 |
| `runs/ID/verification.txt` | 判题输出摘要；完整日志见 evidence/logs/verifier/output.txt |
| `runs/ID/evidence/` | 收集的 project、home、job、logs、outcome/result |
| `runs/ID/collection.json` | 收集结果与文件哈希 |

工具按内层 toolCallId 配对，模型耗时看 model_stream_start/end；审批状态看 approval_review/state。请求日志遵循被测版本的 HiCode Storage Layout，仅在排查具体问题时定位；它可能含代码和凭据相关上下文，分享前脱敏。

一次状态核对后根据任务结束、用户追问或明确异常再读取。若用户只要求启动，交付网页地址与实际运行情况后结束回复；不得承诺不存在的自动唤醒功能。

周期收集失败见 `collection-error.txt`，不能仅据此判断 Agent 执行失败。快照中的符号链接只记录目标文本，不应解引用读取宿主文件。FEAL 编译只使用封存后的独立测试副本；Headless 临时根只用于判题。判题依赖准备失败是 unavailable，不能计作模型答错。

准备新题可用 prepare-terminal/prepare-swe 的 `--ids ID1,ID2`，批量核对必需命令、输入与固定依赖。Django 的开发检查器随原仓库 pre-commit 版本缓存，SymPy 使用原环境声明的开发依赖；不升级旧尝试环境。公开自测 helper 与隐藏 verifier 使用不同视图；判题的私有 chroot 根不向 Agent 开放。源码正在调整时先保存批次配置和准备证据，待最新源码验证并冻结后再提交；不能复用旧 payload 声称测试了新框架。

## 已完成 SWE 的仅验收复核

仅在用户明确要求复验时使用 `bun hicode-eval/src/cli.ts regrade --data-dir "$HE_DATA" --run RUN_ID`。它先核对历史原题包、`prediction.json` 和原 `model.patch` 哈希，再在单独目录执行原判题；不会运行 Agent、调用模型或重交任务。结果位于 `runs/RUN_ID/rechecks/REVIEW_ID/`，含 `result.json`、`logs/verifier/validity.json`、原目标与回归测试状态；首次 run 的状态与分数不回写。验收环境、补丁或原测试节点无法完成时记录 `unavailable`，不是模型代码失败。复验成功也只是这次补丁判题结论，不改变首次执行事实。
