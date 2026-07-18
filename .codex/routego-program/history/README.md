# Routego Program 历史与无损检索

当前 program.json 和 threads/*.json 只保存有效状态。被收敛的完整旧内容没有删除：history/pre-pd008-state-index.json 记录源提交、Git blob、SHA-256 和字节数。

定向读取格式：

git show <sourceCommit>:<path>

读取后必须核对索引中的 Git blob 与 SHA-256。只有 PD-008 的定向展开或全量审计触发条件成立时才加载对应历史。
