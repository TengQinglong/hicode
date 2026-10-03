# 本机评测环境定位

以下是现有本机环境的路径线索，不是运行状态或可用性保证。从已确认的 HiCode checkout 根目录解析；目录不存在时明确报告，不自动另开数据根或重建机器。

| 用途 | 相对 checkout 的路径 / 标识 |
| --- | --- |
| 当前运行数据根 | `../hicode-eval-data/container-v1/` |
| 累计成绩台账 | `../hicode-eval-data/catalog/catalog.json` |
| 历史精简存档 | `../hicode-eval-data/catalog/run-archive/` |
| 环境层与题目绑定 | `../hicode-eval-data/container-v1/environments-clean-v2/` |
| 服务配置真相源 | 上述数据根内的 `config.json` |
| 人工核对与依赖准备记录 | `../hicode-eval-data/records/TASK-STATUS.md` |
| 尚未提交的临时题组配置 | `../hicode-eval-data/batch-configs/` |
| 上次看板入口 | `http://127.0.0.1:8878` |
| 专用 Linux 准备机 | `hicode-eval-clean` |
| Docker context | `colima-hicode` |

接手时一次读取 config.json 的 `data/catalog/environments/payload/context/machine/concurrency/model`，确认 paths 和实际监听服务一致。catalog、environments 与 payload 应按配置读取，不根据题组名称、旧日志或文件名猜目录。模型凭据使用其中的环境变量名，Key 不打印、不复制到配置。

服务不在运行时，先按 config.json 的 context/machine 用 Docker inspect 检查专用机器；有用户启动测试的指令后再通过 eval.sh serve 复用同一 data-dir、catalog、environments 和 payload。机器停止时可以启动配置中的同名容器；容器已删除时按 README 的干净准备机命令从 base.json 的 imageId 重建，不恢复旧缓存卷。活动任务期间不部署另一版、不另开同机服务。

外部 TASK-STATUS 是历史人工记录；累计成绩以 catalog.json 为准，实时运行以 status 和对应 batches/runs 为准。旧 six-tasks-20260928 已结束运行已压缩归档，不能再据旧目录为空推断成绩丢失。原题清单中的哈希只证明已审核输入，不能证明 wheel 缓存、系统工具、网络和资源现在就绪。

本机 `~/.codex/skills/hicode-test` 符号链接指向 checkout 的 `hicode-eval/skills/hicode-test/`。其他窗口读取同一份 Skill；改仓库目录或移动 checkout 后，应重新确认符号链接目标，而不是维护另一份独立复制。

当前 Colima hicode 配置为 6 CPU、16 GiB 内存、180 GiB 磁盘；容器上限不等于预留内存，5 并发仍需关注实际资源使用。虚拟机重启后使用 bash .devcontainer/linux.sh engine-start 恢复 AppArmor 配置。

2026-10-03 已切换到 version 2 配方式镜像与 hicode-eval-clean。旧 hicode-eval-linux 和 version 1 镜像保留用于历史核对，不作为新底座输入。干净环境目前只准备五题回归组合，其余题目的累计成绩保留，但不能因历史通过就视为环境就绪。切换记录见 ../hicode-eval-data/records/clean-environment-v2-20261003.json。
