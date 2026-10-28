# FilmEdit Agent

通过对话协作的视频创作 Agent。用户确定自己在意的主题、内容和表达，其余由 Agent 创作；先形成创意与脚本，再补充素材、完成剪辑和检查，交付可审阅、可继续修改的视频作品。

TypeScript + pi-agent-core，默认连接 DeepSeek V4.1 Flash，也支持 Claude。SQLite 保存任务和账号记忆，HyperFrames 绘制画面，FFmpeg 处理素材、音轨和编码。

产品目标、核心使用体验与验收标准见 [产品需求文档](docs/product-requirements.md)。实现说明和测试通过不等于作品已经达到产品要求。

## 运行

需要 Node.js 22.22+、FFmpeg、ffprobe。网络素材需要 yt-dlp；ASR、节拍、语义评分和分割需要下面的 Python 环境（建议 Python 3.11/3.12，以匹配 PyTorch 等依赖的二进制包）。首版支持 macOS/Linux，当前端到端验证在 macOS 完成。

```bash
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js tui
```

默认进入视频剪辑 TUI，自动连接或启动本地后台 Server。所有任务和素材库操作通过 Server 完成；关闭 TUI 不会中断任务。完整迁移架构、交互说明和验证见 [pi 工作台说明](docs/pi-workbench.md)。

## 对话、任务与共享素材库

```bash
node dist/cli.js                         # TUI
node dist/cli.js chat '先讨论片子的创意'  # 命令行对话，返回 conversationId
node dist/cli.js chat '继续' --conversation CONVERSATION_ID
node dist/cli.js library import /absolute/path/to/videos --category video
node dist/cli.js library search --query 汽车 --category video
node dist/cli.js library analyze LIB_ID --features frames,vision,asr
node dist/cli.js pause TASK_ID
node dist/cli.js resume TASK_ID
node dist/cli.js server status
node dist/cli.js server stop
```

素材库分 meme、sfx、bgm、video 四类，同一 FILMEDIT_HOME 中所有任务共享。原件默认只建立索引，导入后在后台抽帧或做音频分析；ASR、节拍与视觉描述可按需追加。按内容哈希去重并复用分析，只有 bind 到具体任务时才创建素材快照。没有逐任务的素材库授权页面。任务外的目录读写仍按用户给定路径授权。

TUI 支持对话、脚本/旁白、分镜、素材、日志、创意六个面板，Ctrl+T 切换任务，Ctrl+N 新对话，Ctrl+O 在本地浏览器预览。`/review` 打开带流程连线的节点审阅页，可查看脚本、试听旁白、核对素材片段、播放预览和导出审阅意见。`/artifacts` 查看历史中间产物，`/revise script 修改要求` 改旁白，`/revise editorial 修改要求` 改镜头，`/revise layout 修改要求` 改构图。`/export 16:9` 仅导出新规格。自然语言也能操作；只讨论时不启动剪辑。

F6 或 `/compare` 比较两个已归档创意，宽屏并排、窄屏上下显示；`/compare a`、`/compare b` 分页选择候选，`/prefer` 记录更喜欢 A、更喜欢 B、都不好或无法比较。偏好绑定正在查看的任务版本与候选，任务更新后需重新查看。比较不要求已有素材，不自动生成候选、切换制作方案或启动任务。

制作完成、流程检查通过与用户接受分别记录。自由创作无需账号也能留下反馈。在 TUI 中先用 `/preview` 打开当前成片，再用 `/feedback accept 这版可以采用`、`/feedback reject 节奏不合适` 或 `/feedback changes_requested 开头需要修改` 提交正式结论；`/feedback comment 意见` 可在任意阶段记录意见，`/feedback` 查看历史。反馈绑定预览时的任务版本和产物，成片更新后需要重新审阅；记录意见不会自动启动改稿。

对话 Agent 只能原样记录当前用户消息作为意见，不能替用户提交正式接受结论。正式结论通过 TUI、CLI 或 API 的用户入口提交。有账号时，意见同时记入该账号的反馈记忆；修改记忆不改写作品的反馈历史。CLI 示例及接口见 [作品反馈](docs/pi-workbench.md#作品反馈)。

正常顺序是创意 → 脚本 → 素材补充与匹配 → 剪辑 → 布局与渲染。无需先填满素材库。确实缺素材时保留创意和脚本，具体缺口显示在素材阶段。

局部改稿在 `task.revise` 中用 `scope` 明确保护范围外的内容。例如当前任务版本为 1：

```bash
node dist/cli.js task revise TASK_ID --json '{"expectedVersion":1,"kind":"editorial","instruction":"只加强开头三秒，后面保留","scope":{"start":0,"end":3}}'
```

程序会检查范围外的素材源位置、声音包络、字幕和动画。TUI 可用 `/revise editorial 0:3 加强开头，后面保留` 明确范围；自然语言对话也会把明确的时间范围转换为这个参数。时间单位为秒。

`run/resume/export` 现在返回持久化 job，不再把整个任务挂在 CLI 进程上；用 `--wait` 可等待该 job 完成。任务状态包括 queued、running、pausing、paused、blocked、completed、cancelled；对话的必要追问另有 waitingInput 标记，避免把后台剪辑误标成等待输入。

## DeepSeek 连接：填写一个 Key

首次 checkout 后执行 `cp .env.example .env`，然后填写：

```dotenv
DEEPSEEK_API_KEY=你的DeepSeek_API_Key
```

然后执行：

```bash
npm run model:test
npm start
```

`model:test` 通过真实 pi Agent 子进程 检查认证、请求及结构化工具调用，不依赖素材、TTS 或本地评分模型。API Key 不会写入任务记录或诊断输出。自检会产生少量模型调用费用，并在 90 秒后超时。

默认设置为 `FILMEDIT_PROVIDER=deepseek`、`FILMEDIT_MODEL=deepseek-flash-v4.1`，自动使用 `https://api.deepseek.com`。官方 V4.1 Flash 的 API ID 为 `deepseek-flash`，代码会将 `deepseek-flash-v4.1` 和 `deepseek-v4.1-flash` 映射到它；这是官方滚动别名，不代表冻结某个服务端权重快照。映射依据 [DeepSeek 发布说明](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 与 [DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion)。

DeepSeek 使用原生 Chat Completions 流式协议，pi 统一模型调用。阶段产物通过 `submit_result` 工具提交 JSON，由 Zod 和领域校验器共同校验；评审格式或证据错误直接返回同一个 Agent 修复。pi 不管理任务状态，阶段重试和恢复由 FilmEdit 的状态机控制。无需 Anthropic Key。

环境变量示例见 `.env.example`。CLI 仅自动读取本项目安装目录的 `.env`，不会从素材目录查找配置；已导出的环境变量优先。也可以用 Node 的 `--env-file` 显式指定文件。`FILMEDIT_HOME` 默认是当前目录下的 `.filmedit`。可选的 `DEEPSEEK_BASE_URL` 用于显式切换兼容网关。

完整剪辑使用本地评分模型、Whisper ASR 和 Piper 中文 TTS。除 DeepSeek/Claude 的模型调用外，没有必需的付费 API、订阅或云端渲染服务。DeepSeek Key 负责创作与评审；本地模型只需初始化下载。切回 Claude 时同时设置 `FILMEDIT_PROVIDER=anthropic`、`FILMEDIT_MODEL=claude-sonnet-4-6` 和 `ANTHROPIC_API_KEY`。

```bash
node --env-file=.env dist/cli.js create --input examples/task.local.json
node --env-file=.env dist/cli.js run TASK_ID
node dist/cli.js status TASK_ID
node --env-file=.env dist/cli.js resume TASK_ID
node dist/cli.js cancel TASK_ID
```

新任务默认不限制费用、Agent 调用轮数、阶段修订次数和渲染修复次数。`budgets` 的四个字段省略或设为 `null` 都表示不限；费用估算仍会记录。只有显式填写正数时才启用对应限制。评审未通过会继续修订；同一任务范围内，相同候选再次得到相同拒绝反馈时，以 `NO_PROGRESS` 停止重复循环，保存候选、反馈和检查点。更改内容、素材片段或得到新反馈后可继续，不设有进展的总修订次数上限。评审报告格式出错由原评审会话修复，不触发重剪；真实工具故障也会报错并保存检查点。可随时用 `pause` 暂停，或用 `cancel` 取消。TUI 的 Ctrl+C 只退出界面，任务仍在 Server 中运行。

制作阶段要求提交结构化产物。Agent 若只回答普通文字或返回空结果，会先收到提交提醒；相同无效回答再次出现时，保存会话并返回 `NO_PROGRESS`，修正后可继续该会话。正常的用户对话允许文字回答，不要求提交制作产物。

已有任务保留创建时的配置。解除旧任务的全部预算限制后，可继续使用原检查点：

```bash
node dist/cli.js unlimit TASK_ID
node dist/cli.js resume TASK_ID
```

`unlimit` 只更新配置并记录变更，不启动任务，也不清零历史费用和轮数。运行中的任务需先停止；升级代码后，已启动的 API 服务需重启。API 可用 `PUT /tasks/:id/budgets` 和空对象 `{}` 解除全部限制。

先把示例里的素材路径改成真实绝对路径。也可以直接传参：

```bash
node dist/cli.js create --prompt '展示这次制作的完整过程' \
  --asset /absolute/path/to/materials --strategy local_only \
  --deny /absolute/path/to/materials/private --duration 60
```

`local_only` 只限制素材来源；DeepSeek/Claude 仍是远程服务。`local_first` 优先本地素材，`web_first` 优先网上素材。旁白由本地 Piper CPU 模型生成，实际音频时长先于时间线规划确定；纯画面作品可以没有旁白。

## 内容画布、导出与创意采样

内容构图与导出参数已经分开。`composition` 定义参考画布和素材适配，`output` 定义最终宽高、比例和帧率。新任务默认按素材选择参考比例，素材和导出都默认 `contain` 完整保留，显式 `cover` 才允许裁切。同一份已批准 IR 可以另行导出：

```bash
node dist/cli.js export TASK_ID --ratio 16:9 --height 1080 --fps 30
node dist/cli.js export TASK_ID --ratio 4:3 --height 1080 --fps 30
```

新任务默认在脚本之前执行“意图识别 → 文化检索 → 创意候选 → 独立理解评审 → 采样冻结”。主题、内容、表达中用户确定的字段保持不变，留白由创意模块生成。预算默认仍不限；旧任务保持原语义。

```bash
node dist/cli.js creative TASK_ID
node dist/cli.js creative TASK_ID --resample --seed next-idea
node dist/cli.js resume TASK_ID
```

完整 JSON、CLI/API 接口、原文与技术条件校验、知识来源和人工偏好接口见 [构图与创意实现说明](docs/creative-render-implementation.md)。其中 `creative.knowledge=local` 不进行文化网页检索；`web` 使用免费公开来源。首次升级后需要重启已运行的 API 服务。

## 本地模型

模型下载是独立、显式的初始化步骤，不会在剪辑任务中静默下载。`MODEL_REQUIRED` 表示所需本地检索或媒体模型未就绪，和 DeepSeek API 的认证无关。内容与表达由独立远程模型评审，制作不再依赖本地 NLI。`model:test` 仅检查远程模型连接，不能代替本节的初始化。

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/provision_models.py .filmedit/models --whisper --audio
.venv/bin/python python/provision_tts.py .filmedit/models
```

如果使用 uv，可用 `uv venv --python 3.12 .venv` 和 `uv pip install --python .venv/bin/python -r python/requirements.txt` 完成前两步。

然后将项目 `.env` 中以下两项改成真实绝对路径（保留已有 API Key）：

```dotenv
FILMEDIT_PYTHON=/absolute/path/to/FilmEditDemo/.venv/bin/python
FILMEDIT_MODEL_DIR=/absolute/path/to/FilmEditDemo/.filmedit/models
```

已启动的 API 服务需要重启才能读取新配置。之后可以用 `node dist/cli.js resume TASK_ID` 恢复原任务，无需重新创建。Node 的 SQLite `ExperimentalWarning` 是提示，不是 `MODEL_REQUIRED` 的原因。

上面的命令下载 BGE-M3、XLM-R XNLI、faster-whisper-small、AST AudioSet 声音分类和 CLAP 音频—文本模型，记录不可变 Hub commit 到 `manifest.json`，后续运行离线加载。只下载实际使用的权重、分词器和特征配置；下载中断可重新执行，`download-lock.json` 保留原版本，`manifest.json` 仅记录已完成的模型。下载体积较大。声音分类使用 CPU、单线程和确定性算法，不需要额外 API Key。人像分割用配置的 Python 执行 `python/provision_matte.py 模型目录`，按固定 rembg 版本的校验和下载 U2Net；色度抠像不需要模型。

生产评分没有关键词 fallback。没有评分模型、ASR 模型、API 凭据或渲染依赖时任务会阻塞，并保存具体原因。`distance < 0.15` 是初始阈值，不是经过真实业务数据校准的质量保证。

## 素材与权限

选择文件仅授权读取该文件，选择目录授权递归读取。`--read` 增加可读路径，`--write` 增加可写路径，`--deny` 收窄范围。原始素材始终只读。分析、下载、快照和成品写进任务工作目录。

任务启动不递归导入所有素材。素材阶段通过分页目录工具发现用户选择的文件或 `--read` 授权的目录，只导入选中文件，再检查实际画面和声音。用户要求根据采访、字幕或实拍内容写作时，脚本和事实审查可按需读取这些已授权来源；未来镜头的补充与匹配仍由素材阶段完成。无需用户重复手动导入或绑定，也不会把私有文件自动加入共享素材库。已缓存来源在恢复使用前仍检查权限与哈希。

网络下载工具明确选择 `video` 或 `audio`。音效、BGM 可来自独立音频文件，也可提取视频中的音轨；提取不分离原本混合在一起的旁白、音乐和环境声。任务与共享素材库使用同一套实际音视频流识别，支持 Opus；纯音频 WebM 和带封面的 MP3 不会被当成视频。下载结果必须符合请求类型，再进入素材索引。

音频匹配通过 `audio_evidence` 读取指定源区间的实际声音：每次最多 30 秒，返回分段音量、AudioSet 类别预测、CLAP 对固定声音描述的余弦相似度和本地 ASR。两个声音模型都不接收素材标题或需求标签；相似度不是置信度，模型有分歧时保留不确定。独立素材评审核对这些证据，空 ASR、节拍记录或文件标题不能证明匹配。成片评审重新分析最终混音，并可用 `rendered_audio` 检查较短区间；剪辑评审用 `cut_audio` 查看已选音轨区间。缓存绑定源文件哈希、区间和模型版本，读取缓存仍检查素材权限与变化。类别分数不是正确率，Music 不足以证明 Funk，声音类别识别也不等于音乐审美；证据不足保留疑点，不宣称模型亲耳听过。

- 本地、下载和生成素材统一为 `Asset`，包含哈希、时长、尺寸、ASR、帧和节拍。
- 每次复用缓存或渲染前重新检查来源权限和哈希。复制为快照后再次核对哈希。
- 路径服务解析真实路径、检查新文件父目录；目录扫描不跟随符号链接。
- pi 运行时不提供通用文件/终端工具；原子工具在服务端检查权限。子进程使用固定版本的 Sandbox Runtime，读取范围显式收窄，路径按字面值处理。
- 系统运行依赖、字体、解释器和模型是单独声明的内部只读范围。后台学习有自己的配置，不继承剪辑任务的本地目录权限。
- 浏览器和学习代码编译器的权限进一步缩小到当前渲染目录，不能读取参考视频或其他任务的数据。macOS 仅额外允许 Chromium 子进程的 Mach rendezvous 命名空间。
- 沙箱不可用时失败，不自动降级为不受限执行。已提供的资料可能进入远程模型上下文；目录授权不是离线处理承诺。

## IR 与检查点

规范类型在 `packages/core/src/domain.ts`。两个 IR 均为 JSON，版本为 1。

| 数据             | 内容                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `EditorialIR`    | 镜头源区间、独立视觉轨道、时间线位置、速度、转场、声音和可见文字   |
| `RenderIR`       | 绑定的剪辑哈希、固定画布、节点、分组、位置、裁切、样式和关键帧     |
| `AudienceIR`     | 观众理解、事件、因果、情绪、疑点和带时间的证据                     |
| `AcceptancePlan` | 与原要求对应的验收条件、时间区间、证据类型和可执行检查             |
| 对齐报告         | 固定条件与创意表达分别评分，记录逐项证据、待检查项、阻塞原因与版本 |

坐标采用父容器归一化矩形，或锚点 + 尺寸 + 偏移。分组继承变换。`keyframes` 描述动画关键帧，文字由固定浏览器和字体环境排版。RenderIR 编译为 HyperFrames HTML；不提供任意 HTML 反向编辑。

`shots.track` 默认 0，主轨必须覆盖完整时长；其他轨道可按需要同时出现，用于不同素材的分屏、画中画或透明前景。转场只连接同轨镜头。画面位置由 RenderIR 决定，轨道编号不代替构图策略。手法引用必须对应实际时序，例如卡点需对齐已分析的音乐节拍，J/L cut 需有同步源声音提前进入或延后退出。

独立观众没有用户提示词、创作解释或账号记忆。镜头 ID 会中性化，避免名称泄露答案。剪辑评审读取选中源区间的真实帧和语音转录，未入片素材和跨越裁切边界的转录不作为证据；视觉评审读取成片帧和每秒 4 帧的连续片段，并可调用 rendered_frames 补看任意区间。连续预览片段覆盖整片及切点；声音证据来自最终混音的实际 ASR、音量与静音检测，不能用源转录代替。当前模型没有原生听音能力，因此不宣称已评判音乐情绪、音色或混响质感。

验收分为程序硬校验和独立语义评审。`AcceptancePlan` 只提取可以测量的参数：画面容器、播放倍率、音轨数量、静音/字幕限制和完整保留源画面等。提取与独立审查都不能看候选剪辑，原始语义要求保留全文。没有数值或机械要求的来源允许空 checks，不再扩写成 NLI 原子命题。

观众仍只读实际素材或成片、不知道目标。另一独立 DeepSeek 上下文读取冻结要求、观众的完整观察与程序硬校验，逐项给出 `supported`、`contradicted` 或 `insufficient`，解释依据并引用证据。旁白不能证明画面出现了某物；无关观察不是相反事实，未知不能通过。语义评审不是确定性相似度；任何硬校验失败都不能被模型通过覆盖。旧本地 NLI 的诊断与反例仍保留用于研究，不参与制作验收。

报告格式和引用错误由评审自身修正；模型请求失败保存检查点，不当作作品缺陷反复重剪。评审版本改变后保留原剪辑、布局和不可变预览，先复审已有作品。文化与素材检索可使用本地 embedding 排序，它不判断作品是否合格。创意阶段的固定语义条件也由独立模型上下文核对，不以已经获取素材为前提。

脚本修订输入包含完整上一版、带审查角色的反馈和近期阻塞问题，避免修好又改坏。观众脚本评审只看实际稿件，不看创作者的 angle 或 Persona 解释。各项审查单独保存；中断后继续审查同一版，复用输入、权限与素材版本相同且通过的审查。警告作为建议保留，阻塞问题仍禁止进入剪辑阶段。

## 账号与学习

```bash
node dist/cli.js accounts --name '我的账号'
node dist/cli.js memory ACCOUNT_ID --query '表达风格'
node dist/cli.js create --account ACCOUNT_ID --prompt '需求'
node dist/cli.js learn --input examples/learning.json
node --env-file=.env dist/cli.js learn --run EXPERIMENT_ID
node --env-file=.env dist/cli.js learn --daemon --interval 300
node dist/cli.js learn --list
node dist/cli.js releases
node dist/cli.js rollback
```

内置 8 个明确标记为虚构的 Persona。账号真实经历必须来自用户；来源视频中的叙述和模型推断单独标记。显式设置与反馈进入任务记忆快照，历史自动记录。

新任务单独读取本账号的全部明确设置，并分别召回近期反馈、Persona 和与主题有关的记录；全局知识库增长不会挤掉账号设置。记忆提供创作参考，本次明确要求仍优先。任务恢复复用已经保存的记忆快照，纠正或删除账号记忆会影响之后创建的任务，不会静默改写正在制作的作品。

学习 daemon 空闲时处理队列，并使用通用选题补充探索；前台任务优先，不限制每日实验数。实验的 `usd` 和 `maxAttempts` 默认是 `null`（不限），连续无进展会记录反馈并要求调整实现。重复提交相同学习记录或相同实现、且再次得到相同拒绝结果时，以 `NO_PROGRESS` 保留检查点并停止当前实验；仅改假设说明或版本号不能代替实现变化。新学习任务不会自动获得前台素材权限。

手法学习不能重放参考素材：用独立训练素材重建，比较时序、运动、布局和转场，再在 3 个保留素材及不同画幅上独立评审。当前视频特征比较是可解释的基线，尚未用大规模视频集校准，也没有把像素一致当作跨素材手法一致。

学习 Agent 可提交纯 HTML 编译器 `packages/media/src/compositor.ts`、纯视频滤镜 `packages/media/src/techniques.ts`、扩展模块和创作技能，候选版本先编译并运行固定测试，再执行保留素材评审。控制程序负责发布和回滚，运行中任务固定版本。学习代码在隔离的编译子进程执行；权限、数据库、状态机、评分器、发布器、评审技能和测试不能由学习补丁修改。创作角色读取任务绑定版本的技能，评审角色始终使用受保护的技能。这里的持续学习更新知识、代码和技能，不训练基础模型权重。

学到的手法还会保存为版本化 DSL 宏。可以把以下结构作为剪辑草稿通过 API 提交；编译器会替换素材槽、缩放时间和关键帧，再执行常规 IR 校验与观众评审。Agent 的 `techniques` 工具返回当前任务版本可用的手法与素材槽，`apply_technique` 可预览展开结果。

```json
{
  "technique": { "id": "learned_match_cut", "version": 1 },
  "bindings": { "asset_training_slot": "asset_from_current_task" },
  "duration": 10,
  "text": { "title_1": "当前作品的标题" }
}
```

## 本地 API

```bash
node --env-file=.env dist/cli.js serve --port 8787
```

只监听 `127.0.0.1`。随机访问 token 存在权限为 0600 的 `FILMEDIT_HOME/daemon.json`；可用 `FILMEDIT_API_TOKEN` 固定配置。每个请求需 `Authorization: Bearer TOKEN`，写请求为 JSON；浏览器跨域请求默认拒绝。

| 接口                                       | 用途                                          |
| ------------------------------------------ | --------------------------------------------- |
| `POST /tasks`、`GET /tasks/:id`            | 创建、查看任务                                |
| `POST /tasks/:id/run`、`resume`、`cancel`  | 执行与取消                                    |
| `PUT /tasks/:id/permissions`               | 更新权限并重建 Worker                         |
| `PUT /tasks/:id/budgets`                   | 替换预算配置；`{}` 解除全部限制，不启动任务   |
| `POST /tasks/:id/exports`                  | 同一剪辑/布局按独立规格另行导出               |
| `GET /tasks/:id/creative`                  | 意图、候选、冻结方案与选择记录                |
| `POST /tasks/:id/creative/resample`        | 重新采样并使下游产物失效                      |
| `POST /tasks/:id/creative/feedback`        | 人工创意 A/B 反馈                             |
| `GET/POST /tasks/:id/culture`              | 文化知识检索与导入                            |
| `GET /tasks/:id/assets`                    | 素材清单                                      |
| `PUT /tasks/:id/editorial`、`layout`       | 提交修改，重新经过评审                        |
| `GET /tasks/:id/artifacts/:stage`          | 读取结构化产物，`accepted=false` 可读最新候选 |
| `GET /tasks/:id/events`                    | SSE；支持 Last-Event-ID                       |
| `GET /tasks/:id/video`                     | 已通过流程的视频                              |
| `POST /tasks/:id/feedback`                 | 写入明确用户反馈                              |
| `GET/POST /accounts`                       | 账号管理                                      |
| `GET/POST /accounts/:id/memory`            | 账号记忆                                      |
| `GET/POST /learning/experiments`           | 查看、排队学习实验                            |
| `GET /releases`、`POST /releases/rollback` | 版本与回滚                                    |

## 验证与已知边界

仓库包含源码、测试和产品文档；本地任务、素材、渲染产物及验收运行记录不随代码发布。产品目标与验收标准见 [产品需求文档](docs/product-requirements.md)，当前实现仍需完整的真实成片与人工验收。

```bash
npm test
npm run test:integration
```

单元测试验证 IR、权限、评分聚合、记忆隔离和格式解析。集成测试实际启动系统沙箱、FFmpeg 和 Chromium，验证渲染、进程权限、任务恢复、API 和发布流程；配置本地 Piper 后，还验证真实中文旁白合成与音轨渲染。工作流测试用明确标记的 fixture Agent 与语义评审，不能代替真实模型的创作效果评测。

端到端创作仍需要可用的大模型账户；余额不足、认证失败或模型效果问题会保存检查点并明确报错。本地 TTS 不需要额外账户或 Key。

依赖审计当前报告 Sandbox Runtime 的传递依赖 `node-forge` 存在 RSA 签名校验公告（GHSA-86w9-cpqp-85rv）。本项目未启用其 TLS 解密/MITM 功能；保留支持字面路径约束的固定版本，未使用会移除必要权限功能的自动降级建议。需跟踪上游修复。

参考：[pi v1.4.0](https://github.com/earendil-works/pi/tree/v1.4.0)、[Sandbox Runtime](https://github.com/anthropics/sandbox-runtime)、[HyperFrames HTML](https://hyperframes.heygen.com/reference/html-schema)、[HyperFrames Producer](https://hyperframes.heygen.com/packages/producer)。

本地 TTS 使用 [Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md)，固定 `piper-tts==1.8.0`，默认中文模型为 `zh_CN-huayan-medium`。初始化下载约 63 MB，保存 Hub commit、SHA256 和原始模型卡；合成过程不下载模型、不请求云端 TTS。模型位于 `FILMEDIT_MODEL_DIR/tts/`；可通过 `FILMEDIT_TTS_MODEL` 指定另一个已下载的 Piper ONNX 模型（同路径需有 `.json` 配置），`FILMEDIT_TTS_SPEED` 控制语速，默认 `1`。输出为本地 WAV，经过时长、PCM 样本与音量校验后再加入素材库。旧 `DOUBAO_*` 环境变量不再使用。

### 账号记忆纠正

`filmedit memory list --account ACCOUNT_ID` 查看记忆。使用 `filmedit memory correct MEMORY_ID --account ACCOUNT_ID --json '{"content":"更正后的信息","tags":[]}'` 纠正，或 `filmedit memory remove MEMORY_ID --account ACCOUNT_ID` 删除。更改保留审计记录，不能跨账号修改，也不会把虚构 Persona 变成真实经历。

### 撤回错误的学习知识

已发布的脚本学习记录可以逐条查看和撤回。使用 `learn --list` 找到实验 ID，再执行：

```bash
filmedit command learning.knowledge --json '{"experimentId":"experiment_ID"}'
filmedit command learning.retract --json '{"experimentId":"experiment_ID","memoryId":"memory_ID","reason":"该人物经历关联错误"}'
```

查看结果区分 `active` 与 `retracted`，分页使用返回的 `nextOffset`。撤回会在一个事务内删除该条全局记忆、全文索引、对应文化条目及其关系，同时保留原内容、来源、置信度和撤回原因。后续检索不再返回这条记录；已保存的任务快照和学习发布记录保留，重复请求不会重复撤回或重新发布。账号记忆不受影响，剪辑手法仍通过版本回滚管理。撤回由用户通过 CLI/API 直接提交，对话 Agent 只负责查看和解释，不自动删除全局知识或重新学习。

### 从用户偏好学习创作方法

创意比较仍使用 `/compare` 和 `/prefer` 收集真实人类反馈。除本地算子权重外，`strategy` 实验可以总结方法的适用条件、作用机制和反例。账号的反馈可跨任务使用；无账号时限定在一个任务内，不合并其它任务的私人偏好。

```bash
filmedit command learning.enqueue --json '{"kind":"strategy","scope":"account_ID"}'
filmedit command learning.run --json '{"id":"experiment_ID"}'
filmedit command creative.strategy --json '{"scope":"account_ID"}'
filmedit command creative.strategy.retract --json '{"scope":"account_ID","version":"返回的版本","reason":"撤回原因"}'
```

需将 ID 替换为实际账号或实验；`scope` 也可使用制作任务 ID。样本不足会保存明确的缺口，不调用模型伪造投票。启用空闲学习后，调度器优先处理具有新反馈的创作方法实验，再进行网络参考学习；不会因同一数据上的失败反复创建实验。

实验至少需要十个独立题材：至少五个用于总结，另外至少五个用于独立预测人类偏好。分组者只看题材与剧情；总结者不看保留集；预测者不看真实选择、理由和作者自评，正反交换提案位置后必须一致。程序比较新方法和冻结的原方法，检查正确率及配对检验；通过才发布。训练或评估已使用的题材均不能再次冒充新题材。

`creative.strategy` 返回 `none`、`active` 或 `stale`。用户更正来源偏好后，新任务停止使用过期方法；任务已经保存的上下文继续冻结。撤回保留实验和来源，仅停止后续使用。这里验证的是提案偏好预测，不等于实际成片质量或用户采用；真实跨题材改进仍需实际人类反馈验收。
