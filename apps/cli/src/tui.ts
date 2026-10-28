import {
  TuiAltScreen,
  ProcessTerminal,
  Editor,
  Text,
  VStack,
  HStack,
  ScrollView,
  SelectList,
  matchesKey,
  type Terminal,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';
import { spawn } from 'node:child_process';
import { FilmClient } from '../../../packages/client/src/client.js';
import { invariant } from '../../../packages/core/src/util.js';
import { parseRevisionCommand } from '../../../packages/core/src/commands.js';
import { feedbackLabels, workFeedbackSchema } from '../../../packages/core/src/feedback.js';
import {
  preferenceLabels,
  preferenceSchema,
  type ConceptComparison,
} from '../../../packages/core/src/creative-domain.js';
import { CreativeComparisonView } from './creative-comparison.js';

const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`,
  accent = (s: string) => `\x1b[38;5;150m${s}\x1b[0m`;
const theme: SelectListTheme = {
  selectedPrefix: accent,
  selectedText: accent,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};
const states: Record<string, string> = {
  queued: '排队',
  running: '执行中',
  pausing: '正在暂停',
  paused: '已暂停',
  waiting_input: '等待回复',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
};
const stages: Record<string, string> = {
  materials: '素材补充与匹配',
  creative: '创意',
  script: '脚本',
  editorial: '剪辑',
  layout: '布局',
  render: '渲染',
  complete: '完成',
};
const tabs = ['对话', '脚本', '分镜', '素材', '日志', '创意'];
export function stageSummary(task: any) {
  return task
    ? `${states[task.status] ?? task.status} · ${stages[task.stage] ?? task.stage} · v${task.version}`
    : '未选择任务';
}
export function artifactSummary(stage: string, data: any): string {
  if (!data) return '此阶段还没有产物。';
  if (stage === 'script')
    return `${data.title}\n\n选题：${data.topic}\n角度：${data.angle}\n\n旁白\n${data.narration}\n\n节拍\n${data.beats?.map((b: any) => `${b.id} · ${b.durationHint}s  ${b.text}\n  画面：${b.visualQuery}`).join('\n\n') ?? ''}`;
  if (stage === 'editorial')
    return `剪辑方案 · ${data.shots?.length ?? 0} 个镜头\n\n${data.shots?.map((s: any) => `${s.id}  ${s.start.toFixed(2)}–${(s.start + s.duration).toFixed(2)}s\n  素材 ${s.assetId} · 源 ${s.sourceStart}s · ${s.speed}×\n  手法 ${s.techniques?.map((t: any) => t.id).join(' / ') || '基础剪切'}`).join('\n\n') ?? ''}\n\n音轨\n${data.audio?.map((a: any) => `${a.id} · ${a.role} · ${a.start}s · ${a.assetId}`).join('\n') ?? ''}`;
  return JSON.stringify(data, null, 2);
}
export class FilmTui {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private header = new Text('', 1, 0);
  private navigation = new Text('', 1, 0);
  private content = new Text('', 1, 1);
  private sidebar = new Text('', 1, 1);
  private inspector = new Text('', 1, 1);
  private footer = new Text('', 1, 0);
  private liveScroller: ScrollView;
  private reviewScroller: ScrollView;
  private get scroller() {
    return this.tab === 0 || this.tab === 4 ? this.liveScroller : this.reviewScroller;
  }
  private abort = new AbortController();
  private conversationId = '';
  private taskId?: string;
  private tasks: any[] = [];
  private messages: any[] = [];
  private artifacts: any[] = [];
  private selectedArtifact?: any;
  private feedbackTarget?: { taskId: string; taskVersion: number; artifactId: string };
  private comparison?: ConceptComparison;
  private comparisonView = new CreativeComparisonView();
  private comparisonRead = 0;
  private tab = 0;
  private logs: string[] = [];
  private streaming = '';
  private notice = '';
  private cursor = 0;
  private messageCursor = 0;
  private interval?: NodeJS.Timeout;
  private refreshPending = false;
  private closing = false;
  private stream?: Promise<void>;
  private references: { kind: string; id: string }[] = [];
  private libraryPage: any;
  private libraryQuery = '';
  private libraryOffset = 0;
  private libraryCategory?: string;
  constructor(
    readonly client: FilmClient,
    readonly terminal: Terminal = new ProcessTerminal(),
  ) {
    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: theme });
    this.liveScroller = new ScrollView(this.content, { follow: 'end', primary: true, scrollbar: 'auto' });
    this.reviewScroller = new ScrollView(
      {
        render: (width) => (this.tab === 5 ? this.comparisonView.render(width) : this.content.render(width)),
        invalidate: () => this.content.invalidate(),
      },
      { follow: 'none', primary: true, scrollbar: 'auto' },
    );
    const body = new HStack(
      [
        {
          component: new ScrollView(this.sidebar),
          basis: 27,
          grow: 0,
          visible: (v) => this.tab !== 5 && v.width >= 90,
        },
        {
          component: this.liveScroller,
          grow: 1,
          minSize: 30,
          visible: () => this.tab === 0 || this.tab === 4,
        },
        {
          component: this.reviewScroller,
          grow: 1,
          minSize: 30,
          visible: () => this.tab !== 0 && this.tab !== 4,
        },
        {
          component: new ScrollView(this.inspector),
          basis: 32,
          grow: 0,
          visible: (v) => this.tab !== 5 && v.width >= 125,
        },
      ],
      { gap: 1 },
    );
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.header, shrink: 0 },
        { component: this.navigation, shrink: 0 },
        { component: body, basis: 0, grow: 1 },
        { component: this.editor, shrink: 0 },
        { component: this.footer, shrink: 0 },
      ]),
    );
    this.tui.setFocus(this.editor);
    this.editor.onSubmit = (text) => {
      void this.submit(text).catch((e) => {
        this.notice = clean(e.message);
        this.render();
      });
    };
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        void this.close();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        this.pickTasks();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+n')) {
        void this.newConversation();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        void this.preview().catch((e) => {
          this.notice = clean(e.message);
          this.render();
        });
        return { consume: true };
      }
      if (matchesKey(data, 'pageUp')) {
        this.scroller.scrollBy(-10);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'pageDown')) {
        this.scroller.scrollBy(10);
        this.tui.requestRender();
        return { consume: true };
      }
      for (let i = 0; i < tabs.length; i++)
        if (matchesKey(data, `f${i + 1}` as any)) {
          this.tab = i;
          void this.loadTab().catch((e) => {
            this.notice = e.message;
            this.render();
          });
          return { consume: true };
        }
      return undefined;
    });
  }
  async start(conversationId?: string) {
    const conversations = await this.client.request('/conversations');
    const conversation = conversationId
      ? await this.client.request(`/conversations/${conversationId}`)
      : (conversations[0] ?? (await this.client.request('/conversations', 'POST', {})));
    this.conversationId = conversation.id;
    this.taskId = conversation.task_id ?? undefined;
    await this.refresh();
    this.tui.start();
    this.render();
    this.interval = setInterval(() => {
      void this.refresh().catch((e) => {
        this.notice = `连接中断：${clean(e.message)}`;
        this.render();
      });
    }, 2000);
    this.stream = this.events();
    return this;
  }
  private async events() {
    for await (const event of this.client.events({ after: this.cursor, signal: this.abort.signal })) {
      this.cursor = event.seq;
      if (event.conversation_id === this.conversationId && event.type === 'agent.delta') {
        this.streaming += event.data.text;
        this.render();
      }
      if (event.conversation_id === this.conversationId && event.type === 'message.completed') {
        this.streaming = '';
        void this.refresh();
      }
      if (event.task_id === this.taskId || event.conversation_id === this.conversationId) {
        if (event.type !== 'agent.delta') {
          this.logs.push(`${event.created}  ${event.type}  ${JSON.stringify(event.data).slice(0, 350)}`);
          if (this.logs.length > 300) this.logs.shift();
          if (this.tab === 4) this.render();
        }
      }
    }
  }
  private async refresh() {
    if (this.refreshPending || this.closing) return;
    this.refreshPending = true;
    try {
      const [tasks, conversation] = await Promise.all([
        this.client.command('task.list'),
        this.client.request(`/conversations/${this.conversationId}`),
      ]);
      this.tasks = tasks;
      const changed = this.taskId !== (conversation.task_id ?? undefined);
      if (changed) {
        this.feedbackTarget = undefined;
        this.clearComparison();
      }
      this.taskId = conversation.task_id ?? undefined;
      while (true) {
        const page = await this.client.request(
          `/conversations/${this.conversationId}/messages?after=${this.messageCursor}`,
        );
        if (!page.length) break;
        this.messages.push(...page);
        this.messageCursor = page.at(-1).seq;
        if (page.length < 200) break;
      }
      if (this.taskId) this.artifacts = await this.client.request(`/tasks/${this.taskId}/artifacts`);
      else this.artifacts = [];
      if (changed) await this.loadTab();
      this.render();
    } finally {
      this.refreshPending = false;
    }
  }
  private render() {
    const task = this.tasks.find((t) => t.id === this.taskId);
    this.comparisonView.comparison = this.comparison;
    this.comparisonView.currentVersion = task?.version;
    this.header.setText(
      `${accent('FilmEdit')}   视频剪辑工作台   ${dim(this.client.connection.url)}   ${this.conversationId.slice(-8)}`,
    );
    this.navigation.setText(tabs.map((t, i) => `${i === this.tab ? '●' : '○'} F${i + 1} ${t}`).join('  '));
    this.sidebar.setText(
      `任务  ${this.tasks.length}   Ctrl+T 切换\n\n${this.tasks.map((t) => `${t.id === this.taskId ? '▶' : '·'} ${clean(t.spec.prompt).slice(0, 24)}\n  ${stageSummary(t)}\n`).join('\n')}`,
    );
    this.inspector.setText(
      task
        ? `当前任务\n${task.id}\n\n${stageSummary(task)}\n${feedbackLabels[task.feedback?.decision as keyof typeof feedbackLabels] ?? feedbackLabels.unreviewed}\n\n正在做什么\n${clean(task.progress?.current ?? '')}\n${task.progress?.attempt ? '第 ' + task.progress.attempt + ' 次尝试' : ''}\n最后活动 ${task.progress?.lastActivity ?? task.updated}\n\n下一步\n${clean(task.progress?.nextAction ?? '')}\n\n用户要求\n${clean(task.spec.prompt)}\n\n创作画布\n${task.spec.composition.aspectRatio} / ${task.spec.composition.mediaFit}\n\n导出\n${task.spec.output.width}×${task.spec.output.height} · ${task.spec.output.fps} fps\n\n模型用量估算\n$${task.cost.toFixed(4)}\n\n${task.error ? '问题\n' + clean(task.error.message) : ''}`
        : '新建任务\n\n直接描述想剪的视频。\n可指定主题、内容、表达；其他部分由创意模块发散。\n\n可以先提创意；素材会在方案确定后补充。已有素材也可用 /import 导入。',
    );
    if (this.tab === 0)
      this.content.setText(
        this.messages
          .map(
            (m) =>
              `${m.role === 'user' ? '你' : 'FilmEdit'}${m.task_id ? ' · ' + m.task_id.slice(-8) : ''}\n${clean(m.content.text)}\n`,
          )
          .join('\n') +
          (this.streaming ? '\nFilmEdit · 生成中\n' + clean(this.streaming) : '') +
          (this.messages.length
            ? ''
            : '告诉我你想剪什么，或先讨论一个想法。\n\n例：用素材库里的汽车视频剪一条 30 秒的片子，横屏，保留完整画面。'),
      );
    if (this.tab === 1 || this.tab === 2)
      this.content.setText(
        this.selectedArtifact
          ? `${this.selectedArtifact.stage} · r${this.selectedArtifact.revision} · ${this.selectedArtifact.accepted ? '流程通过' : '待审/历史'}\n${this.selectedArtifact.id}\n\n${clean(artifactSummary(this.selectedArtifact.stage, this.selectedArtifact.data))}\n\n用 /revise script|editorial|layout 修改；/artifact ID 查看历史产物。`
          : '此阶段尚无产物；/artifacts 可选择其他阶段或历史版本。',
      );
    if (this.tab === 3)
      this.content.setText(
        `共享素材库  ${this.libraryCategory ?? '全部类别'}  查询：${clean(this.libraryQuery) || '全部'}\n/import CATEGORY PATH 导入 · /assets QUERY 搜索 · /next 翻页\n/category meme|sfx|bgm|video · /inspect ID · /use ID 引用\n\n${this.libraryPage?.items.map((a: any) => `${a.id}\n${clean(a.title)} · ${a.categories?.join(',')} · ${a.duration}s${a.width ? ' · ' + a.width + '×' + a.height : ''}\n${clean(a.description ?? '')}`).join('\n\n') ?? '尚未加载'}\n\n${this.libraryPage ? `${this.libraryOffset + 1}–${this.libraryOffset + this.libraryPage.items.length} / ${this.libraryPage.total}` : ''}`,
      );
    if (this.tab === 4)
      this.content.setText(
        this.logs.map(clean).join('\n') || '执行事件将出现在这里。重连会从上次事件继续读取。',
      );
    this.footer.setText(
      `${clean(this.notice) || 'Enter 发送 · Shift+Enter 换行 · Ctrl+T 任务 · Ctrl+N 对话 · Ctrl+O 预览 · Ctrl+C 离开'}${this.references.length ? '  引用 ' + this.references.map((r) => r.id).join(',') : ''}`,
    );
    this.tui.requestRender();
  }
  private picker(items: SelectItem[], onSelect: (item: SelectItem) => Promise<void>) {
    const select = new SelectList(items, 12, theme);
    const overlay = this.tui.showOverlay(select, { width: '85%', maxHeight: '75%', anchor: 'center' });
    select.onCancel = () => overlay.hide();
    select.onSelect = (item) => {
      overlay.hide();
      void onSelect(item).catch((e) => {
        this.notice = clean(e.message);
        this.render();
      });
    };
  }
  private pickTasks() {
    this.picker(
      this.tasks.map((t) => ({ value: t.id, label: clean(t.spec.prompt), description: stageSummary(t) })),
      async (item) => {
        await this.client.request(`/conversations/${this.conversationId}/focus`, 'PUT', {
          taskId: item.value,
        });
        this.selectedArtifact = undefined;
        await this.refresh();
      },
    );
  }
  private async newConversation() {
    const c = await this.client.request('/conversations', 'POST', {});
    await this.switchConversation(c.id);
  }
  private async switchConversation(id: string) {
    this.clearComparison();
    this.feedbackTarget = undefined;
    this.conversationId = id;
    this.messages = [];
    this.messageCursor = 0;
    this.streaming = '';
    this.taskId = undefined;
    this.references = [];
    this.logs = [];
    this.tab = 0;
    this.scroller.scrollToEnd();
    await this.refresh();
  }
  private async loadTab() {
    if (this.tab === 0 || this.tab === 4) this.scroller.scrollToEnd();
    else this.scroller.scrollToStart();
    if (this.tab === 5) await this.loadComparison(this.comparison?.left.id, this.comparison?.right.id);
    if (this.tab === 1 || this.tab === 2) {
      const stage = this.tab === 1 ? 'script' : 'editorial',
        row = this.artifacts.find((a) => a.stage === stage);
      this.selectedArtifact = row
        ? await this.client.command('artifact.read', { id: row.id }, this.taskId)
        : undefined;
    }
    if (this.tab === 3)
      this.libraryPage = await this.client.command('library.search', {
        query: this.libraryQuery,
        category: this.libraryCategory,
        offset: this.libraryOffset,
      });
    this.render();
  }
  private clearComparison() {
    this.comparisonRead++;
    this.comparison = undefined;
    this.comparisonView.message = '用 /compare 查看两个已归档候选；不会启动制作。';
  }
  private async loadComparison(left?: string, right?: string) {
    const taskId = this.taskId;
    this.tab = 5;
    this.clearComparison();
    if (!taskId) {
      this.comparisonView.message = '先用 Ctrl+T 选择要比较创意的任务。';
      this.render();
      return;
    }
    const revision = this.comparisonRead;
    this.comparisonView.message = '正在读取候选…';
    this.scroller.scrollToStart();
    this.render();
    try {
      if (!left || !right) {
        const page = await this.client.command('creative.candidates', { limit: 2 }, taskId);
        if (this.taskId !== taskId || this.comparisonRead !== revision) return;
        if (page.items.length < 2) {
          this.comparisonView.message = page.items.length
            ? '目前只有一个已归档候选，尚不能比较两个方案。F6 刷新；单个方案可在流程审阅页查看。'
            : '当前任务尚无已归档创意。F6 刷新；不会为比较自动生成新方案。';
          this.render();
          return;
        }
        [left, right] = page.items.map((item: any) => item.id);
      }
      const comparison = await this.client.command('creative.compare', { left, right }, taskId);
      if (this.taskId !== taskId || this.comparisonRead !== revision) return;
      this.comparison = comparison;
      this.render();
    } catch (error) {
      if (this.taskId !== taskId || this.comparisonRead !== revision) return;
      this.comparisonView.message = `读取候选失败：${clean((error as Error).message)}\n按 F6 重试。`;
      this.render();
      throw error;
    }
  }
  private async chooseCandidate(side: 'left' | 'right', before = 0) {
    const comparison = this.comparison;
    invariant(
      comparison && comparison.taskId === this.taskId,
      'COMPARISON_REQUIRED',
      '先用 /compare 查看候选',
    );
    const opposite = side === 'left' ? comparison.right.id : comparison.left.id;
    const page = await this.client.command('creative.candidates', { before, limit: 12 }, comparison.taskId);
    if (this.comparison !== comparison || this.taskId !== comparison.taskId) return;
    this.picker(
      [
        ...page.items
          .filter((item: any) => item.id !== opposite)
          .map((item: any) => ({
            value: item.id,
            label: clean(item.subject),
            description: clean(item.synopsis),
          })),
        ...(page.nextBefore === null
          ? []
          : [{ value: 'next-page', label: '更早的候选…', description: '加载下一页' }]),
      ],
      async (item) => {
        invariant(
          this.comparison === comparison && this.taskId === comparison.taskId,
          'COMPARISON_CHANGED',
          '任务或比较对象已变化，请重新选择',
        );
        if (item.value === 'next-page') await this.chooseCandidate(side, page.nextBefore);
        else
          await this.loadComparison(
            side === 'left' ? item.value : opposite,
            side === 'right' ? item.value : opposite,
          );
      },
    );
  }
  private async recordPreference(comparison: ConceptComparison, choice: string, comment = '') {
    invariant(
      this.taskId === comparison.taskId && this.comparison === comparison,
      'COMPARISON_CHANGED',
      '任务或比较对象已变化，请重新查看候选',
    );
    const input = preferenceSchema.parse({
      expectedVersion: comparison.taskVersion,
      left: comparison.left.id,
      right: comparison.right.id,
      choice,
      level: 'concept',
      comment,
    });
    const result = await this.client.command('creative.feedback', input, comparison.taskId);
    if (this.comparison === comparison && this.taskId === comparison.taskId) {
      comparison.previous = result;
      this.notice = `${preferenceLabels[input.choice]} · 已保存用户偏好；当前制作方案不变`;
      this.render();
    }
  }
  async preview(kind: 'preview' | 'review' = 'preview') {
    invariant(this.taskId, 'TASK_REQUIRED', '先选择任务');
    const result = await this.client.request(`/tasks/${this.taskId}/${kind}`, 'POST', {});
    if (kind === 'preview') this.feedbackTarget = result;
    const url = this.client.connection.url + result.path;
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    child.on('error', () => {
      this.notice = url;
      this.render();
    });
    this.notice = kind === 'review' ? '已打开流程审阅页' : '已打开本地视频预览';
    this.render();
  }
  private async selectArtifact(artifactId: string) {
    const taskId = this.taskId;
    invariant(taskId, 'TASK_REQUIRED', '先选择任务');
    const taskVersion = this.tasks.find((task) => task.id === taskId)!.version;
    const artifact = await this.client.command('artifact.read', { id: artifactId }, taskId);
    if (this.taskId !== taskId) return;
    this.selectedArtifact = artifact;
    this.feedbackTarget = { taskId, taskVersion, artifactId };
    this.tab = artifact.stage === 'script' ? 1 : 2;
    this.render();
  }
  async submit(input: string) {
    const text = input.trim();
    if (!text) return;
    this.editor.setText('');
    this.editor.addToHistory(text);
    this.notice = '';
    if (!text.startsWith('/')) {
      this.streaming = '';
      await this.client.request(`/conversations/${this.conversationId}/messages`, 'POST', {
        requestId: crypto.randomUUID(),
        text,
        taskId: this.taskId ?? null,
        references: this.references,
      });
      this.references = [];
      this.tab = 0;
      this.scroller.scrollToEnd();
      await this.refresh();
      return;
    }
    const [command, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (command === 'new') await this.newConversation();
    else if (command === 'tasks') this.pickTasks();
    else if (command === 'task') {
      await this.client.request(`/conversations/${this.conversationId}/focus`, 'PUT', { taskId: arg });
      await this.refresh();
    } else if (command === 'history') {
      const rows = await this.client.request('/conversations');
      this.picker(
        rows.map((c: any) => ({ value: c.id, label: clean(c.title), description: c.updated })),
        (item) => this.switchConversation(item.value),
      );
    } else if (['pause', 'resume', 'cancel', 'run'].includes(command!)) {
      invariant(this.taskId, 'TASK_REQUIRED', '先选择任务');
      await this.client.command(`task.${command}`, {}, this.taskId);
      await this.refresh();
    } else if (command === 'preview') await this.preview();
    else if (command === 'compare') {
      if (arg === 'a' || arg === 'b') await this.chooseCandidate(arg === 'a' ? 'left' : 'right');
      else {
        invariant(
          rest.length === 0 || rest.length === 2,
          'CLI_USAGE',
          '/compare 查看候选；/compare a 或 b 换候选；也可 /compare ID_A ID_B',
        );
        await this.loadComparison(rest[0], rest[1]);
      }
    } else if (command === 'prefer') {
      const comparison = this.comparison;
      invariant(
        comparison && comparison.taskId === this.taskId && this.tab === 5,
        'COMPARISON_REQUIRED',
        '先用 /compare 查看要评价的两个候选',
      );
      if (!arg)
        this.picker(
          Object.entries(preferenceLabels).map(([value, label]) => ({
            value,
            label,
            description: '只记录偏好，不改变正在制作的方案',
          })),
          (item) => this.recordPreference(comparison, item.value),
        );
      else {
        const choice = preferenceSchema.shape.choice.safeParse(rest[0]);
        invariant(
          choice.success,
          'CLI_USAGE',
          '/prefer left|right|both_bad|incomparable 意见；不带参数可打开菜单',
        );
        await this.recordPreference(comparison, choice.data, rest.slice(1).join(' '));
      }
    } else if (command === 'assets') {
      this.tab = 3;
      this.libraryQuery = arg;
      this.libraryOffset = 0;
      await this.loadTab();
    } else if (command === 'category') {
      this.libraryCategory = arg === 'all' ? undefined : arg;
      this.libraryOffset = 0;
      this.tab = 3;
      await this.loadTab();
    } else if (command === 'next') {
      this.libraryOffset = this.libraryPage?.nextOffset ?? 0;
      await this.loadTab();
    } else if (command === 'import') {
      invariant(rest[0] && rest[1], 'CLI_USAGE', '/import video|meme|bgm|sfx /完整路径');
      const result = await this.client.command('library.import', {
        category: rest[0],
        paths: [rest.slice(1).join(' ')],
      });
      this.notice = `导入已排队 ${result.id}`;
    } else if (command === 'use' || command === 'shot') {
      this.references.push({ kind: command === 'use' ? 'asset' : 'shot', id: arg });
      this.notice = '已引用，接着输入修改要求';
    } else if (command === 'inspect') {
      const a = await this.client.command('library.inspect', { id: arg });
      this.picker(
        [{ value: arg, label: clean(a.title), description: clean(JSON.stringify(a)) }],
        async () => {
          this.references.push({ kind: 'asset', id: arg });
        },
      );
    } else if (command === 'artifacts')
      this.picker(
        this.artifacts.map((a) => ({
          value: a.id,
          label: `${a.stage} · r${a.revision}`,
          description: a.accepted ? '流程通过/历史' : '候选',
        })),
        async (item) => {
          await this.selectArtifact(item.value);
        },
      );
    else if (command === 'artifact') {
      await this.selectArtifact(arg);
      this.references.push({ kind: 'artifact', id: arg });
    } else if (command === 'review') {
      if (!arg) await this.preview('review');
      else {
        this.tab = arg === 'script' ? 1 : 2;
        await this.loadTab();
      }
    } else if (command === 'feedback') {
      invariant(this.taskId, 'TASK_REQUIRED', '先选择任务');
      const taskId = this.taskId;
      if (!arg) {
        const summary = await this.client.command('task.inspect', {}, taskId);
        const history = await this.client.command('task.feedback.list', {}, taskId);
        this.logs.push(
          `${feedbackLabels[summary.feedback.decision as keyof typeof feedbackLabels]}\n${history.items.map((item: any) => `v${item.taskVersion} · ${feedbackLabels[item.decision as keyof typeof feedbackLabels]} · ${item.artifact?.stage ?? '任务'}\n${clean(item.content)}`).join('\n\n')}`,
        );
        this.tab = 4;
      } else {
        const decision = workFeedbackSchema.shape.decision.safeParse(rest[0]);
        invariant(
          decision.success,
          'CLI_USAGE',
          '用法：/feedback accept|reject|changes_requested|comment 意见；只输入 /feedback 可查看历史',
        );
        const content = rest.slice(1).join(' ');
        invariant(decision.data !== 'comment' || content, 'CLI_USAGE', '请在 /feedback comment 后填写意见');
        const task = this.tasks.find((task) => task.id === taskId);
        const target = this.feedbackTarget?.taskId === taskId ? this.feedbackTarget : undefined;
        invariant(
          decision.data === 'comment' || target,
          'FEEDBACK_TARGET',
          '请先预览要评价的成片，反馈会绑定所看的版本',
        );
        const input = workFeedbackSchema.parse({
          expectedVersion: target?.taskVersion ?? task.version,
          artifactId: target?.artifactId ?? null,
          decision: decision.data,
          dimensions: [],
          content: content || feedbackLabels[decision.data],
        });
        const result = await this.client.command('task.feedback', input, taskId);
        await this.refresh();
        this.notice = `${feedbackLabels[result.decision as keyof typeof feedbackLabels]} · v${result.taskVersion}，已保存；不会自动改稿`;
      }
    } else if (command === 'revise') {
      invariant(this.taskId, 'TASK_REQUIRED', '先选择任务');
      const t = await this.client.request(`/tasks/${this.taskId}`);
      await this.client.command('task.revise', parseRevisionCommand(rest, t.version), this.taskId);
      this.notice = '修改已提交；只重跑受影响阶段';
    } else if (command === 'export') {
      invariant(this.taskId, 'TASK_REQUIRED', '先选择任务');
      await this.client.command('task.export', { aspectRatio: arg || '16:9' }, this.taskId);
      this.notice = '导出已排队';
    } else
      this.notice =
        '/tasks /task ID /new /history /pause /resume /review [script|editorial] /artifacts /assets /import /use /revise /export /preview /compare /prefer /feedback [accept|reject|changes_requested|comment 意见]';
    this.render();
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.abort.abort();
    if (this.interval) clearInterval(this.interval);
    await this.stream;
    this.tui.stop();
    this.terminal.showCursor();
  }
}
export async function launchTui(client: FilmClient, conversationId?: string) {
  return new FilmTui(client).start(conversationId);
}
