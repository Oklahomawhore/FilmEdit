/** Read-only review surface. All content comes from scoped artifacts, never model-authored HTML. */
export function reviewPage(nonce: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FilmEdit · 流程审阅</title><style>
  :root{font:14px/1.6 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#21383d;background:#f3f5f4;--accent:#156c67;--line:#cbd6d2;--muted:#506864}*{box-sizing:border-box}body{margin:0}a{color:var(--accent);text-underline-offset:3px}button,select,textarea{font:inherit;color:inherit}button,select{background:white;border:1px solid var(--line);border-radius:7px;padding:7px 12px}button{cursor:pointer}button:hover{background:#e8f1ed;border-color:#70978c}button:disabled{opacity:.55;cursor:wait}button:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #30867a;outline-offset:3px}::selection{background:#bee5db;color:#102f2b}header{background:#153f43;color:white;padding:14px 24px;display:flex;gap:20px;align-items:center}header strong{font-size:18px}header span{flex:1}header button{background:#153f43;color:white;border-color:#87a7a4}header button:hover{background:#24565a}h1{font-size:23px;font-weight:650;margin:0 0 6px}h2{font-size:19px;margin:0 0 14px}h3{font-size:15px;margin:24px 0 8px}p{margin:6px 0 16px;max-width:72ch}.intro{padding:20px 24px;background:white;border-bottom:1px solid var(--line)}#status{color:var(--muted);margin:0}.workspace{display:grid;grid-template-columns:minmax(380px,46%) minmax(0,1fr);height:calc(100vh - 180px);min-height:560px}.flow{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}.flow>p{padding:12px 20px;margin:0;color:var(--muted);font-size:13px}#viewport{overflow:auto;flex:1}#graph{position:relative;width:560px;height:1000px;margin:auto}#graph svg{position:absolute;inset:0;width:560px;height:1000px;pointer-events:none}.edge{stroke:#69877e;stroke-width:1.5;fill:none}.loop{stroke:#956c3e;stroke-dasharray:5 4}.node{position:absolute;width:232px;height:88px;text-align:left;background:#fff;padding:12px 14px;display:flex;flex-direction:column;justify-content:center}.node strong{font-size:15px}.node span{color:var(--muted);font-size:12px}.node[aria-pressed=true]{background:#dceee7;border-color:var(--accent)}.node.empty{background:#edf0ee}.node.current span{color:#17613c}.details{overflow:auto;padding:24px 28px;min-width:0;background:#fff}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}.toolbar select{max-width:100%;flex:1;min-width:0}.meta{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.empty-state{padding:24px 0;color:var(--muted)}.error{color:#963b30;background:#fff0e9;padding:12px;margin:12px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}td,th{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}th{color:var(--muted);font-weight:600}.table-wrap{overflow:auto}video,img{display:block;max-width:100%;max-height:380px;background:#13262b;margin:12px 0;object-fit:contain}audio{width:100%;margin:12px 0}.copy{white-space:pre-wrap;line-height:1.85}pre{background:#f1f5f2;padding:14px;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;color:var(--accent);margin:16px 0 8px}textarea{width:100%;min-height:100px;padding:12px;border:1px solid var(--line);border-radius:7px;resize:vertical;caret-color:var(--accent)}.review-note{margin-top:28px;padding-top:18px;border-top:1px solid var(--line)}.review-note label{display:block;font-weight:600;margin-bottom:8px}.review-note button{margin-top:8px}.phase-note{color:var(--muted);font-size:13px}#live{min-height:20px;color:var(--muted)}@media(max-width:900px){header{padding:12px 16px;gap:12px}header span{display:none}.intro{padding:16px}.workspace{display:flex;flex-direction:column;height:auto;min-height:0}.flow{border-right:0;border-bottom:1px solid var(--line)}#viewport{height:340px;flex:none}.details{padding:20px 16px;overflow:visible}h1{font-size:20px}.toolbar{align-items:stretch;flex-direction:column}#graph{margin:0}}@media(prefers-reduced-motion:no-preference){button{transition:background-color .15s ease-out}}
  </style></head><body><header><strong>FilmEdit</strong><span>流程审阅</span><button id="refresh">刷新进度</button></header><section class="intro"><h1 id="title">正在读取任务…</h1><p id="status" role="status"></p></section><main class="workspace"><section class="flow" aria-label="制作流程"><p>点击节点查看产物。实线是执行顺序，虚线是评审修订。</p><div id="viewport"><div id="graph"></div></div></section><section class="details" aria-label="节点产物"><div id="live" role="status" aria-live="polite"></div><h2 id="node-title">选择流程节点</h2><div id="artifacts"></div><div id="detail"></div><section class="review-note"><label for="note">我的审阅意见</label><textarea id="note" placeholder="例如：第二个镜头只看到车内，应换成侧面行驶画面。"></textarea><button id="download-notes">导出意见</button><p class="phase-note">意见随当前节点和产物版本导出；可在对话中引用后提出修改。</p></section></section></main><script nonce="${nonce}">(${reviewClient.toString()})();</script></body></html>`;
}

function reviewClient() {
  const base = location.pathname,
    $ = (id: string) => document.getElementById(id)!;
  let data: any,
    nodeId = 'input',
    artifactId: string | undefined,
    selection = 0;
  let loaded = true;
  const setLoaded = (value: boolean) => {
    loaded = value;
    ($('note') as HTMLTextAreaElement).disabled = !value;
    ($('download-notes') as HTMLButtonElement).disabled = !value;
  };
  const notes: Record<string, { nodeId: string; artifactId?: string; text: string }> = {};
  const noteKey = () => nodeId + ':' + (artifactId ?? 'input');
  const saveNote = () => {
    if (!loaded) return;
    const text = ($('note') as HTMLTextAreaElement).value;
    if (text.trim()) notes[noteKey()] = { nodeId, artifactId, text };
    else delete notes[noteKey()];
  };
  const loadNote = () => {
    ($('note') as HTMLTextAreaElement).value = notes[noteKey()]?.text ?? '';
  };
  const el = (tag: string, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const request = async (suffix: string) => {
    const response = await fetch(base + suffix);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? '读取失败，请刷新或重新打开审阅链接');
    return result;
  };
  const table = (headers: string[], rows: unknown[][]) => {
    const wrap = el('div', undefined, 'table-wrap'),
      t = el('table'),
      head = el('tr');
    headers.forEach((h) => head.append(el('th', h)));
    t.append(head);
    rows.forEach((row) => {
      const tr = el('tr');
      row.forEach((v) => tr.append(el('td', String(v ?? '—'))));
      t.append(tr);
    });
    wrap.append(t);
    return wrap;
  };
  const media = (source: string, kind: string) => {
    const player = el(kind === 'image' ? 'img' : kind === 'audio' ? 'audio' : 'video') as
      HTMLMediaElement | HTMLImageElement;
    player.src = source;
    if (player instanceof HTMLMediaElement) {
      player.controls = true;
      player.preload = 'none';
    } else player.alt = '任务素材';
    player.addEventListener('error', () => {
      player.replaceWith(el('p', '此媒体无法读取或格式不受浏览器支持。请检查来源路径与文件状态。', 'error'));
    });
    return player;
  };
  const source = (id: string, start?: number, end?: number) => {
    const asset = data.assets.find((a: any) => a.id === id),
      box = el('section');
    if (!asset) {
      box.append(el('p', '素材未在当前任务登记', 'error'));
      return box;
    }
    box.append(
      el('h3', asset.title ?? id),
      el(
        'p',
        `${asset.width ?? '—'} × ${asset.height ?? '—'} · ${asset.duration.toFixed(2)} 秒 · ${asset.source}`,
        'meta',
      ),
    );
    box.append(
      media(`${base}/asset/${id}${start === undefined ? '' : '#t=' + start + ',' + end}`, asset.kind),
    );
    return box;
  };
  const raw = (value: unknown) => {
    const d = el('details');
    d.append(el('summary', '查看完整结构化产物'), el('pre', JSON.stringify(value, null, 2)));
    return d;
  };
  const showArtifact = async (id: string) => {
    const revision = ++selection;
    saveNote();
    artifactId = id;
    loadNote();
    setLoaded(false);
    $('detail').replaceChildren(el('p', '正在读取所选版本…', 'empty-state'));
    $('live').textContent = '正在读取产物…';
    try {
      const artifact = await request('/artifact/' + encodeURIComponent(id));
      if (revision !== selection) return;
      const d = artifact.data,
        target = $('detail');
      target.replaceChildren();
      target.append(el('p', `${artifact.stage} · r${artifact.revision} · ${artifact.created}`, 'meta'));
      if (artifact.stage === 'script' || artifact.stage === 'script.candidate') {
        target.append(el('h3', d.title), el('p', d.narration || '本片未安排旁白。', 'copy'));
        if (artifact.narration?.assetId) target.append(source(artifact.narration.assetId));
        else if (d.narration) target.append(el('p', '此脚本版本没有匹配的旁白音频。', 'phase-note'));
        target.append(
          table(
            ['段落', '内容', '画面需求', '时长'],
            (d.beats ?? []).map((b: any) => [b.id, b.text, b.visualQuery, b.durationHint]),
          ),
        );
      } else if (artifact.stage === 'narration') target.append(source(d.assetId));
      else if (artifact.stage === 'editorial' || artifact.stage === 'editorial.candidate') {
        target.append(
          el('p', `全片 ${d.duration} 秒 · ${d.shots?.length ?? 0} 个镜头 · ${d.audio?.length ?? 0} 段声音`),
        );
        target.append(
          table(
            ['镜头 / 轨道', '片中时间', '源片段', '速度 / 手法'],
            (d.shots ?? []).map((s: any) => [
              s.id + ' / ' + (s.track ?? 0),
              `${s.start}–${(s.start + s.duration).toFixed(2)}s`,
              `${s.sourceStart}–${(s.sourceStart + s.duration * s.speed).toFixed(2)}s`,
              `${s.speed}× · ${(s.techniques ?? []).map((t: any) => t.id).join('、')}`,
            ]),
          ),
        );
        for (const s of d.shots ?? []) {
          const disclosure = el('details');
          disclosure.append(
            el('summary', `查看 ${s.id} 的实际源片段`),
            source(s.assetId, s.sourceStart, s.sourceStart + s.duration * s.speed),
          );
          target.append(disclosure);
        }
        target.append(
          table(
            ['音轨', '角色', '时间', '音量 / 闪避'],
            (d.audio ?? []).map((a: any) => [
              a.id,
              a.role,
              `${a.start}–${a.start + a.duration}s`,
              `${a.volume} / ${a.duck ? '是' : '否'}`,
            ]),
          ),
        );
      } else if (artifact.stage === 'materials' || artifact.stage === 'materials.candidate') {
        target.append(
          table(
            ['需求', '实际观察', '可用源片段'],
            (d.matches ?? []).map((m: any) => [m.needId, m.observation, `${m.sourceStart}–${m.sourceEnd}s`]),
          ),
        );
        for (const m of d.matches ?? []) {
          const disclosure = el('details');
          disclosure.append(
            el('summary', `核对 ${m.needId} 的素材`),
            source(m.assetId, m.sourceStart, m.sourceEnd),
          );
          target.append(disclosure);
        }
        if (d.gaps?.length)
          target.append(
            table(
              ['缺少的需求', '已尝试', '原因'],
              d.gaps.map((g: any) => [g.needId, g.attemptedQueries?.join('、'), g.reason]),
            ),
          );
      } else if (artifact.stage === 'layout' || artifact.stage === 'layout.candidate') {
        target.append(el('p', `创作画布 ${d.canvas?.width} × ${d.canvas?.height} · ${d.canvas?.fps} fps`));
        target.append(
          table(
            ['元素', '绑定镜头', '呈现方式', '位置'],
            (d.nodes ?? []).map((n: any) => [n.id, n.bindingId, n.fit, JSON.stringify(n.placement)]),
          ),
        );
      } else if (
        (typeof d?.path === 'string' &&
          ['render', 'render.candidate_media', 'layout.preview', 'output.current'].includes(
            artifact.stage,
          )) ||
        artifact.stage.startsWith('export.')
      ) {
        target.append(media(`${base}/output/${id}`, 'video'));
      } else if (artifact.stage === 'creative.brief') {
        const p = d.concept?.proposal;
        target.append(el('h3', p?.theme?.subject), el('p', p?.content?.synopsis, 'copy'));
        target.append(
          table(
            ['创意动作', '画面', '声音'],
            (d.concept?.beats ?? []).map((b: any) => [b.action, b.visual, b.audio]),
          ),
        );
      } else target.append(el('pre', JSON.stringify(d, null, 2)));
      const feedback = data.feedbackHistory.items.filter(
        (item: any) => item.artifact?.hash === artifact.hash,
      );
      if (feedback.length) {
        target.append(el('h3', '这一版的用户反馈'));
        for (const item of feedback)
          target.append(
            el(
              'p',
              `任务 v${item.taskVersion} · ${item.label} · ${item.origin.kind === 'conversation' ? '对话原话' : '用户直接提交'}`,
              'meta',
            ),
            el('p', item.content, 'copy'),
          );
      }
      target.append(raw(d));
      $('live').textContent = '';
      setLoaded(true);
    } catch (e) {
      if (revision === selection) {
        $('live').textContent = '所选版本读取失败';
        $('detail').replaceChildren(el('p', (e as Error).message, 'error'));
      }
    }
  };
  const selectNode = (id: string) => {
    saveNote();
    nodeId = id;
    artifactId = undefined;
    setLoaded(true);
    selection++;
    loadNote();
    const node = data.nodes.find((n: any) => n.id === id);
    $('node-title').textContent = node.label;
    document
      .querySelectorAll('.node')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.id === id)),
      );
    $('detail').replaceChildren();
    $('artifacts').replaceChildren();
    $('live').textContent = '';
    if (id === 'input') {
      $('detail').append(
        el('p', data.task.spec.prompt, 'copy'),
        table(
          ['配置', '当前值'],
          [
            ['创作画布', JSON.stringify(data.task.spec.composition)],
            ['最终导出', JSON.stringify(data.task.spec.output)],
            ['素材策略', data.task.spec.materials.strategy],
            ['任务版本', data.task.version],
            ['运行版本', data.task.releaseId],
          ],
        ),
        raw(data.task),
      );
      return;
    }
    if (!node.artifacts.length) {
      $('detail').append(el('p', '此节点尚无保存的产物。完成上游阶段后会出现在这里。', 'empty-state'));
      return;
    }
    const row = el('div', undefined, 'toolbar'),
      select = el('select') as HTMLSelectElement;
    select.setAttribute('aria-label', '选择产物与版本');
    for (const a of node.artifacts) {
      const o = el(
        'option',
        `${a.stage} · r${a.revision} · ${a.current ? '当前流程通过' : '候选 / 历史'}`,
      ) as HTMLOptionElement;
      o.value = a.id;
      select.append(o);
    }
    const chosen = node.artifacts.find((a: any) => a.current) ?? node.artifacts[0];
    select.value = chosen.id;
    select.onchange = () => void showArtifact(select.value);
    row.append(select);
    $('artifacts').append(row);
    if (node.count > node.artifacts.length)
      $('artifacts').append(
        el(
          'p',
          `展示最近 ${node.artifacts.length} 份，共 ${node.count} 份。完整历史保存在任务数据库。`,
          'meta',
        ),
      );
    void showArtifact(chosen.id);
  };
  const graph = () => {
    const target = $('graph');
    target.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const paths = [
      'M140 112V144',
      'M140 232V264',
      'M140 352V384',
      'M140 472V504',
      'M140 592V624',
      'M140 712V744',
      'M140 832V864',
      ...[188, 308, 548, 668, 788].map((y) => `M256 ${y}H304`),
    ];
    for (const d of paths) {
      const p = document.createElementNS(svg.namespaceURI, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', 'edge');
      svg.append(p);
    }
    for (const y of [144, 264, 504, 624, 744]) {
      const p = document.createElementNS(svg.namespaceURI, 'path');
      p.setAttribute('d', `M420 ${y}V${y - 17}H140V${y}`);
      p.setAttribute('class', 'edge loop');
      svg.append(p);
    }
    target.append(svg);
    for (const n of data.nodes) {
      const button = el(
        'button',
        undefined,
        `node ${n.artifacts.length ? '' : 'empty'} ${n.artifacts.some((a: any) => a.current) ? 'current' : ''}`,
      ) as HTMLButtonElement;
      button.dataset.id = n.id;
      button.style.left = n.x + 'px';
      button.style.top = n.y + 'px';
      button.setAttribute('aria-pressed', 'false');
      button.append(
        el('strong', n.label),
        el('span', n.id === 'input' ? '任务配置与固定条件' : n.count ? `${n.count} 份保存产物` : '尚无产物'),
      );
      button.onclick = () => selectNode(n.id);
      target.append(button);
    }
  };
  const refresh = async () => {
    const button = $('refresh') as HTMLButtonElement;
    button.disabled = true;
    try {
      data = await request('/data');
      $('title').textContent = data.task.spec.prompt;
      $('status').textContent =
        `${data.progress.stageLabel} · ${data.progress.current} · ${data.feedback.label} · 最后活动 ${data.progress.lastActivity}`;
      graph();
      selectNode(nodeId);
    } catch (e) {
      $('status').textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  };
  $('refresh').onclick = () => void refresh();
  $('download-notes').onclick = () => {
    saveNote();
    const blob = new Blob(
      [
        JSON.stringify(
          {
            taskId: data.task.id,
            version: data.task.version,
            capturedAt: data.capturedAt,
            notes: Object.values(notes),
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      link = el('a') as HTMLAnchorElement;
    link.href = url;
    link.download = 'filmedit-review.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  void refresh();
}
