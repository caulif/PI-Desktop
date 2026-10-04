# 原生批准的项目核验

> **翻译说明：** 本页与 [英文源规格](/spec/07-plugins/13-approved-project-verification) 一一对应。代码、协议字段和标识符保持原文；如事实存在歧义，以英文版本为准。

经过审阅且仅供插件使用的操作包括 verification/approveCheck、snapshot、runApprovedCheck、lookupExecution、cancelExecution 和 revokeCheck。外部 MCP 不能调用这些操作。Main 从已加载的插件进程提供插件身份。插件参数不能携带批准 token、claim 或授权标志。

批准通过原生 Main 对话框进行，展示 Host 生成的不可变定义：规范化的可执行文件、固定 argv、可执行文件和脚本 hash、项目、插件所有的 session、digest、限制与过期时间。关闭对话框即拒绝批准。challenge token 仅由 Main 持有且只能使用一次。调用方的确认标志不能替代原生同意。固定命令以操作系统账户权限运行，并非操作系统沙箱；其间接执行的代码以及 Unix 输入可变性属于已记录的限制。

Snapshot 绑定获批命令身份、Git HEAD、已跟踪及未被忽略的工作树内容，以及实际允许传入的执行环境。输入变更、其他 session 或项目、授权过期或撤回，都会拒绝新的执行准入。

执行前先保存 exact request digest 与持久 claim。并发的相同请求返回已有回执。响应不确定或冷重启时，只查询原执行，不再次启动。启动恢复将失去进程所有权的 executing 回执改为 unknown，并使其 coordinator claim 失效。授权撤回或输入变化后，已有执行仍可查询与取消。查询校验保存的精确请求以及当前有效的所属 scope。

Host 负责进程创建、清理环境变量、限制输出、超时、进程树所有权与取消。取消意图不是成功回执。完成要求有实际测量的输出与执行后 snapshot；清理失败、超时、截断、取消或测量缺失时，状态保持 incomplete。进程成功退出不等于内容或工程质量的人类审阅。

Bot session 使用 ADR 0314 所述不可放宽的工具策略。文件调用使用发起调用的 session 所属项目；项目缺失时不能借用窗口当前工作区。目录列表会对目标目录及每个返回条目执行 realpath 包含检查。
