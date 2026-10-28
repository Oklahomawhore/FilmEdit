---
name: library
description: 使用 filmedit library 检索、管理和绑定共享本地素材库。
---

四类素材：meme（表情包）、sfx（音效）、bgm（音乐）、video（视频）。分类可以重叠。所有任务共用 FILMEDIT_HOME 下的索引。原件只读；默认仅索引，不复制；选中后 bind 生成任务快照。

CLI 或 film_cli 使用同一参数数组，无 shell：

```
filmedit library import /path/to/files --category video --tag 汽车
filmedit library search --query 汽车 --category video --limit 20
filmedit library search --query 紧张悬疑 --category bgm --semantic
filmedit library inspect lib_ID
filmedit library analyze lib_ID --features frames,vision,asr
filmedit library analyze lib_ID --features audio,beats
filmedit library bind lib_ID --task task_ID
filmedit library refresh
filmedit library update lib_ID --json '{"tags":["反应","惊讶"]}'
filmedit library remove lib_ID
```

import/analyze/refresh 返回后台 job；用 job.inspect 看状态。CLI 通用格式 `filmedit command job.inspect --json '{"id":"job_ID"}'`。不要重复提交同一个耗时分析。ASR、节拍、语义检索需要本地模型，视觉描述用已配置的大模型。

结果有 items、total、nextOffset，使用 nextOffset 翻页，不能只看第一页就判断素材不存在。库 ID 以 lib_ 开头，不能直接写入 EditorialIR。先 bind，再使用返回的任务 assetId 调用 frame/asr，验证画面和时间范围。检索分数只是候选排序，不是实际画面的证据。只有采样帧支持的内容才能进入匹配说明。原件缺失或变化时重新导入，不能沿用旧分析。

创作 Agent 只允许 search/inspect/bind；管理、导入和删除由对话 Agent 根据用户要求执行。阅片 Agent 不读取库描述、用户目标或创作解释，只读实际剪辑中的证据。
