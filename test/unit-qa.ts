// 单元测试：纯函数与约束（不启动服务、不修改产品代码）
// 运行：npx tsx test/unit-qa.ts
process.env.DATABASE_PATH = '/tmp/atoms-qa-unit.db'
process.env.MOCK_MODE = '1'
process.env.LLM_PROVIDERS = ''
process.env.LLM_BASE_URL = ''
process.env.LLM_MODELS = ''

let total = 0
let passed = 0
const failures: Array<{ id: string; name: string; error: string }> = []

function test(id: string, name: string, fn: () => void): void {
  total += 1
  try {
    fn()
    passed += 1
    console.log(`PASS  ${id} ${name}`)
  } catch (err) {
    failures.push({ id, name, error: (err as Error).message })
    console.log(`FAIL  ${id} ${name} → ${(err as Error).message}`)
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, label = ''): void {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function includesAll(text: string, parts: string[]): void {
  for (const p of parts) assert(text.includes(p), `缺少期望内容：${p}`)
}

async function main(): Promise<void> {
  const { staticCheck, extractHtml } = await import('../src/server/verify/static-check.js')
  const { scoreProbe } = await import('../src/server/verify/score.js')
  const { hashPassword, verifyPassword, checkRateLimit } = await import('../src/server/auth.js')
  const { mockPlan } = await import('../src/server/agents/planner.js')
  const { heuristicReview } = await import('../src/server/agents/reviewer.js')
  const { pickTemplate, mockHtml, escapeHtml } = await import('../src/server/mock/templates.js')
  const { buildSrcDoc } = await import('../src/client/components/Sandbox.js')
  const { SANDBOX_RUNTIME } = await import('../src/shared/runtime.js')
  const { chooseQaCases, buildAcceptance, buildRetestPlan, isRepairLimitReached, QA_MAX_CASES, QA_MAX_REPAIR_ROUNDS } = await import('../src/shared/qa.js')
  const { deriveStageProgress } = await import('../src/shared/stage-progress.js')

  const qaFeatures = (patch: Partial<import('../src/shared/qa.js').QaFeatures> = {}) => ({
    hasInput: false,
    hasPrimary: false,
    hasSecondary: false,
    hasDelete: false,
    hasClear: false,
    hasList: false,
    itemCount: 0,
    listLike: false,
    hasStorage: false,
    hasKeyboard: false,
    overflow: false,
    width: 375,
    ...patch,
  })
  const qaCase = (id: string, kind: string, status: 'passed' | 'failed' = 'passed', evidence = '已执行') => ({
    id,
    kind: kind as import('../src/shared/qa.js').QaCaseKind,
    title: `${kind} 用例`,
    status,
    evidence,
    durationMs: 100,
  })
  const qaReport = (cases: ReturnType<typeof qaCase>[]) => ({
    status: cases.some((c) => c.status === 'failed') ? ('failed' as const) : ('passed' as const),
    cases,
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    durationMs: 1200,
    width: 375,
  })

  const VALID_HTML = mockHtml('kanban', '做一个任务看板')

  test('U01', 'staticCheck：合法单文件 HTML 得满分且 ok', () => {
    const r = staticCheck(VALID_HTML)
    eq(r.score, 10, '静态分')
    eq(r.ok, true, 'ok')
    eq(r.items.length, 6, '检查项数')
  })

  test('U02', 'staticCheck：缺 doctype/脚本/viewport/体积不足时按项扣分', () => {
    const r = staticCheck('<html><body>hi</body></html>')
    eq(r.ok, false, 'ok')
    assert(r.score <= 3, `期望低分，实际 ${r.score}`)
    includesAll(r.errors.join('、'), ['<!DOCTYPE html>', '内联脚本', 'viewport', '内容长度'])
  })

  test('U03', 'staticCheck：外链资源被识别并扣 2 分', () => {
    const html = VALID_HTML.replace('</head>', '<link rel="stylesheet" href="https://cdn.example.com/a.css"></head>')
    const r = staticCheck(html)
    assert(r.items.find((i) => i.key === 'external')?.pass === false, '应判定外链')
    eq(r.score, 8, '静态分')
  })

  test('U04', 'extractHtml：剥离 Markdown 围栏与前后解释文字', () => {
    const raw = `下面是代码：\n\`\`\`html\n${VALID_HTML}\n\`\`\`\n以上。`
    const html = extractHtml(raw)
    assert(html.startsWith('<!DOCTYPE html>'), '应以 doctype 开头')
    assert(html.endsWith('</html>'), '应以 </html> 结尾')
    assert(!html.includes('```'), '不应保留围栏')
  })

  test('U05', 'extractHtml：裸片段原样返回', () => {
    eq(extractHtml('  <div>hello</div>  '), '<div>hello</div>')
  })

  test('U06', 'scoreProbe：完整实测数据得 50 分', () => {
    const r = scoreProbe({
      elements: 160,
      textLength: 520,
      errors: [],
      errorCount: 0,
      clicks: 3,
      mutations: 12,
      keys: 2,
      writes: 3,
      overflowX: false,
      width: 1280,
      title: 'QA',
      interactiveClicks: 3,
      simulatedClicks: 8,
      simulatedChanges: 12,
    })
    eq(r.score, 50, '实测分')
    eq(r.items.length, 5, '项数')
  })

  test('U07', 'scoreProbe：空数据得 0 分且给出超时证据', () => {
    const r = scoreProbe(null)
    eq(r.score, 0, '实测分')
    assert(
      r.items.every((i) => i.evidence.includes('未收到浏览器实测数据')),
      '应有超时证据',
    )
  })

  test('U08', 'scoreProbe：报错数/交互强度/横向溢出的分档', () => {
    const base = {
      elements: 20,
      textLength: 100,
      errors: ['e1'],
      errorCount: 1,
      clicks: 1,
      mutations: 1,
      keys: 0,
      writes: 0,
      overflowX: true,
      width: 375,
      title: '',
      interactiveClicks: 1,
      simulatedClicks: 1,
      simulatedChanges: 1,
    }
    const r = scoreProbe(base)
    const item = (k: string) => r.items.find((i) => i.key === k)
    eq(item('render')?.score, 10, '渲染')
    eq(item('errors')?.score, 6, '1 条报错')
    eq(item('interactive')?.score, 11, '1 点击 1 变化')
    eq(item('mobile')?.score, 0, '横向溢出')
  })

  test('U09', 'password：scrypt$salt$hash 格式、正确/错误密码校验', () => {
    const stored = hashPassword('QaPass1234')
    const parts = stored.split('$')
    eq(parts.length, 3, '段数')
    eq(parts[0], 'scrypt', '算法')
    assert(parts[1].length >= 16, '盐长度')
    eq(verifyPassword('QaPass1234', stored), true, '正确密码')
    eq(verifyPassword('wrong-pass', stored), false, '错误密码')
    eq(verifyPassword('x', null), false, '空哈希')
    eq(verifyPassword('x', 'bad-format'), false, '坏格式')
  })

  test('U10', 'rateLimit：滑动窗口内超限拒绝，窗口结束后恢复', () => {
    const key = `unit-${Date.now()}`
    eq(checkRateLimit(key, 2, 60), true, '第 1 次')
    eq(checkRateLimit(key, 2, 60), true, '第 2 次')
    eq(checkRateLimit(key, 2, 60), false, '第 3 次应拒绝')
    const end = Date.now() + 90
    while (Date.now() < end) {
      /* 等待窗口过期 */
    }
    eq(checkRateLimit(key, 2, 60), true, '窗口后应恢复')
  })

  test('U11', 'buildSrcDoc：注入 CSP、runtime、初始化数据并转义 <', () => {
    const doc = buildSrcDoc(VALID_HTML, { evil: '</script><img onerror=1>' }, SANDBOX_RUNTIME)
    includesAll(doc, ["connect-src 'none'", 'form-action', "__ATOMS_RUNTIME__", '__ATOMS_INIT__'])
    assert(doc.includes('\\u003c'), '初始化 JSON 中的 < 应被转义')
    assert(!doc.includes('evil": "</script>'), '不应原样注入 </script>')
  })

  test('U12', 'buildSrcDoc：无 head 时补 head；空 HTML 显示等待态', () => {
    const noHead = buildSrcDoc('<!DOCTYPE html><html><body>hi</body></html>', {}, SANDBOX_RUNTIME)
    assert(noHead.includes('<head>'), '应补 head')
    const empty = buildSrcDoc('', {}, SANDBOX_RUNTIME)
    assert(empty.includes('等待生成'), '空态提示')
  })

  test('U13', '模板路由：6 种品类优先级正确，模板均通过静态检查', () => {
    eq(pickTemplate('习惯打卡，连续天数'), 'habit', '打卡')
    eq(pickTemplate('项目看板，支持拖拽'), 'kanban', '看板')
    eq(pickTemplate('2048 数字合并游戏'), 'game2048', '2048')
    eq(pickTemplate('做一个番茄钟专注计时'), 'pomodoro', '番茄钟')
    eq(pickTemplate('记账本，记录支出'), 'expense', '记账')
    eq(pickTemplate('Markdown 笔记'), 'notes', '笔记')
    eq(pickTemplate('周末读书计划清单'), 'kanban', '清单不应误判为打卡')
    for (const kind of ['kanban', 'habit', 'game2048', 'pomodoro', 'notes', 'expense'] as const) {
      const html = mockHtml(kind, 'QA 模板')
      eq(staticCheck(html).score, 10, `${kind} 静态分`)
    }
  })

  test('U17', '模板关键能力：交互入口、键盘/滑动、数据持久化键齐全', () => {
    const markers: Record<string, string[]> = {
      kanban: ['atoms_kanban_v2', '添加任务', '删除'],
      habit: ['atoms_habit_v1', '连续', '添加习惯'],
      game2048: ['atoms_2048_best_v1', 'touchstart', 'ArrowLeft', '重新开始'],
      pomodoro: ['atoms_pomodoro_v1', '开始专注', '跳过'],
      notes: ['atoms_notes_v1', '预览', 'confirm'],
      expense: ['atoms_expense_v1', '分类', '请输入大于 0 的金额'],
    }
    for (const [kind, parts] of Object.entries(markers)) {
      includesAll(mockHtml(kind as Parameters<typeof mockHtml>[0], 'QA'), parts)
    }
  })

  test('U14', 'escapeHtml：< > & 引号全部转义', () => {
    const out = escapeHtml(`<a href="x">'&</a>`)
    eq(out, '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;')
    assert(!out.includes('<a'), '不应保留标签')
  })

  test('U15', 'mockPlan：固定 6 条验收清单，标题可识别品类', () => {
    const plan = mockPlan('做一个记账本')
    eq(plan.checklist.length, 6, '清单条数')
    eq(plan.title, '记账本', '标题')
    eq(plan.source, 'mock', '来源')
  })

  test('U16', 'heuristicReview：完整实测 40 分；无实测 0 分', () => {
    const checklist = mockPlan('看板').checklist
    const full = heuristicReview(
      checklist,
      {
        elements: 160,
        textLength: 520,
        errors: [],
        errorCount: 0,
        clicks: 3,
        mutations: 12,
        keys: 2,
        writes: 3,
        overflowX: false,
        width: 1280,
        title: 'QA',
        interactiveClicks: 3,
        simulatedClicks: 8,
        simulatedChanges: 12,
      },
      VALID_HTML,
    )
    eq(full.score, 40, '完整实测')
    eq(full.source, 'heuristic', '来源')
    const none = heuristicReview(checklist, null, VALID_HTML)
    eq(none.score, 0, '无实测')
  })

  test('U18', 'QA 用例选择：无功能时只生成加载与视口检查', () => {
    const specs = chooseQaCases(qaFeatures())
    eq(specs.length, 2, '用例数')
    eq(specs[0].kind, 'load', '首条')
    eq(specs[1].kind, 'viewport', '次条')
    assert(specs[1].title.includes('375'), '视口标题应包含实际宽度')
  })

  test('U19', 'QA 用例选择：功能齐全时覆盖主流程、表单、删除、持久化且不超过上限', () => {
    const specs = chooseQaCases(
      qaFeatures({
        hasInput: true,
        hasPrimary: true,
        hasSecondary: true,
        hasDelete: true,
        hasClear: true,
        hasList: true,
        hasStorage: true,
        hasKeyboard: true,
      }),
    )
    eq(QA_MAX_CASES, 10, '上限')
    assert(specs.length <= QA_MAX_CASES, `不应超过 ${QA_MAX_CASES} 条`)
    eq(specs.length, 10, '完整功能应达到 10 条上限')
    const kinds = specs.map((s) => s.kind)
    for (const kind of ['load', 'viewport', 'main-flow', 'invalid-input', 'keyboard', 'delete', 'clear', 'last-delete', 'persistence', 'double-click']) {
      assert(kinds.includes(kind as (typeof kinds)[number]), `缺少 ${kind}`)
    }
  })

  test('U20', 'QA 预检过滤：没有对应功能的目标不生成用例', () => {
    const noInput = chooseQaCases(qaFeatures({ hasPrimary: true, hasList: true, hasStorage: true }))
    const kinds = noInput.map((s) => s.kind)
    assert(!kinds.includes('invalid-input' as never), '无输入框不应生成表单用例')
    assert(!kinds.includes('keyboard' as never), '无输入框不应生成键盘用例')
    assert(!kinds.includes('delete' as never), '无删除按钮不应生成删除用例')
    assert(!kinds.includes('last-delete' as never), '无删除按钮不应生成删最后一条用例')
    assert(!kinds.includes('clear' as never), '无清空按钮不应生成清空用例')
    const noStorage = chooseQaCases(qaFeatures({ hasPrimary: true, hasStorage: false }))
    assert(!noStorage.map((s) => s.kind).includes('persistence' as never), '无存储写入不应生成持久化用例')
  })

  test('U21', '验收映射：只收录有已执行 QA 证据的条目，可选未实现项省略', () => {
    const report = qaReport([
      qaCase('qa1', 'load'),
      qaCase('qa2', 'viewport'),
      qaCase('qa3', 'main-flow'),
      qaCase('qa4', 'persistence'),
    ])
    const acceptance = buildAcceptance(
      [
        { id: 'c1', text: '首屏可直接使用，无白屏' },
        { id: 'c2', text: '可以添加记录' },
        { id: 'c3', text: '刷新后数据仍在' },
        { id: 'c4', text: '支持导出 PDF' },
      ],
      report,
    )
    eq(acceptance.items.length, 3, '可选未实现项不应出现')
    eq(acceptance.score, 40, '验收分')
    eq(acceptance.coreFailed, false, '核心缺失')
    eq(acceptance.items.every((i) => i.caseIds.length > 0), true, '每条都应有 QA case 关联')
    assert(!acceptance.items.some((i) => /未实现|未验证|未执行/.test(i.text)), '不应出现未实现/未验证行')
  })

  test('U22', '验收映射：核心需求缺功能判失败，两轮后 blocked', () => {
    const report = qaReport([qaCase('qa1', 'viewport')])
    const checklist = [{ id: 'c1', text: '首屏可直接使用，无白屏' }]
    const first = buildAcceptance(checklist, report, 0)
    eq(first.items.length, 1, '核心项应保留')
    eq(first.items[0].status, 'failed', '核心项状态')
    eq(first.items[0].caseIds.length, 0, '无关联用例')
    eq(first.coreFailed, true, '核心缺失')
    eq(first.blocked, false, '首轮不应 blocked')
    const second = buildAcceptance(checklist, report, 1)
    eq(second.blocked, false, '第 1 轮修复后不应 blocked')
    const third = buildAcceptance(checklist, report, QA_MAX_REPAIR_ROUNDS)
    eq(third.blocked, true, '达到修复上限应 blocked')
    eq(third.maxRepairRounds, 2, '上限轮数')
  })

  test('U23', '验收映射：非核心项 QA 失败计分，核心全部通过时不算核心缺失', () => {
    const report = qaReport([
      qaCase('qa1', 'load'),
      qaCase('qa2', 'main-flow'),
      qaCase('qa3', 'keyboard', 'failed', '回车后无响应'),
    ])
    const acceptance = buildAcceptance(
      [
        { id: 'c1', text: '首屏可直接使用' },
        { id: 'c2', text: '可以添加记录' },
        { id: 'c3', text: '支持键盘操作' },
      ],
      report,
    )
    eq(acceptance.coreFailed, false, '核心缺失')
    eq(acceptance.items.length, 3, '三条均有 QA 证据')
    eq(acceptance.items.find((i) => i.id === 'c3')?.status, 'failed', '非核心失败状态')
    eq(acceptance.score, 27, '验收分（2/3 通过）')
  })

  test('U24', '验收映射：可选需求全部未实现时不影响得分与展示', () => {
    const report = qaReport([qaCase('qa1', 'load')])
    const acceptance = buildAcceptance(
      [
        { id: 'c1', text: '首屏可直接使用' },
        { id: 'c2', text: '可以添加记录' },
        { id: 'c3', text: '支持导出 PDF' },
        { id: 'c4', text: '支持多语言' },
      ],
      report,
      0,
    )
    // c2 属于核心（前两条），没有 main-flow 用例 → 核心失败
    eq(acceptance.coreFailed, true, '核心缺失')
    eq(acceptance.items.length, 2, '只保留核心与有关联用例的条目')
    eq(acceptance.items[0].status, 'passed', '核心首屏通过')
    eq(acceptance.score, 20, '核心项按 1/2 计分')
  })

  test('U25', '修复轮复测计划：失败用例去重 + 1 条冒烟', () => {
    eq(buildRetestPlan(['main-flow', 'main-flow', 'delete']).map((p) => p.kind).join(','), 'main-flow,delete,load', '失败项 + load')
    eq(buildRetestPlan(['load', 'viewport']).map((p) => p.kind).join(','), 'load,viewport', 'load 失败时冒烟用 viewport')
    eq(buildRetestPlan(['persistence']).map((p) => p.kind).join(','), 'persistence,main-flow', '持久化失败时用主流程造数')
    assert(buildRetestPlan(['main-flow']).length <= QA_MAX_CASES, '复测计划不应超过上限')
  })

  test('U26', '修复上限：用完 2 轮且仍有失败后不再提供修复，与核心 blocked 区分', () => {
    const failed = { ...qaReport([qaCase('qa1', 'load', 'failed', '执行失败')]), maxRepairRounds: 2 }
    assert(!isRepairLimitReached({ ...failed, repairRounds: 0 }), '首轮不应达到上限')
    assert(!isRepairLimitReached({ ...failed, repairRounds: 1 }), '第 1 轮后不应达到上限')
    assert(isRepairLimitReached({ ...failed, repairRounds: 2 }), '第 2 轮后应达到上限')
    const passed = { ...qaReport([qaCase('qa1', 'load')]), repairRounds: 2, maxRepairRounds: 2 }
    assert(!isRepairLimitReached(passed), '全部通过不应显示修复上限')
  })

  const stageSteps = (patch: Record<string, 'running' | 'done' | 'failed'>) =>
    Object.fromEntries(Object.entries(patch).map(([key, status]) => [key, { status }])) as Record<
      string,
      { status: 'running' | 'done' | 'failed' }
    >

  test('U27', '阶段映射：初始运行停在需求规划', () => {
    const p = deriveStageProgress({
      runStatus: 'running',
      steps: { plan: { status: 'running' } },
      hasFirstCandidate: false,
      hasVersion: false,
      qaEnabled: null,
      hasReport: false,
      hasConclusion: false,
    })
    eq(p.currentKey, 'plan', '当前阶段')
    eq(p.currentIndex, 0, '索引')
    eq(p.summary, '当前：需求规划 1/6', '摘要')
    eq(p.stages[0].status, 'running', '规划进行中')
    eq(p.stages[1].status, 'pending', '生成待执行')
  })

  test('U28', '阶段映射：规划完成进入生成，首候选就绪进入赛马', () => {
    const generating = deriveStageProgress({
      runStatus: 'running',
      steps: stageSteps({ plan: 'done', generate: 'running' }),
      hasFirstCandidate: false,
      hasVersion: false,
      qaEnabled: null,
      hasReport: false,
      hasConclusion: false,
    })
    eq(generating.currentKey, 'generate', '生成阶段')
    eq(generating.stages[0].status, 'done', '规划已完成')
    const racing = deriveStageProgress({
      runStatus: 'running',
      steps: stageSteps({ plan: 'done', generate: 'running' }),
      hasFirstCandidate: true,
      hasVersion: false,
      qaEnabled: null,
      hasReport: false,
      hasConclusion: false,
    })
    eq(racing.currentKey, 'race', '赛马阶段')
    eq(racing.summary, '当前：赛马 3/6', '赛马摘要')
    eq(racing.stages[2].status, 'running', '赛马进行中')
  })

  test('U29', '阶段映射：版本保存进入测试，QA 完成后进入验收', () => {
    const qa = deriveStageProgress({
      runStatus: 'running',
      steps: stageSteps({ plan: 'done', generate: 'done', review: 'running', qa: 'running' }),
      hasFirstCandidate: true,
      hasVersion: true,
      qaEnabled: true,
      hasReport: false,
      hasConclusion: false,
    })
    eq(qa.currentKey, 'qa', '测试阶段')
    eq(qa.stages[2].status, 'done', '赛马已完成')
    eq(qa.stages[3].status, 'running', '测试进行中')
    const acceptance = deriveStageProgress({
      runStatus: 'running',
      steps: stageSteps({ plan: 'done', generate: 'done', qa: 'done', review: 'running' }),
      hasFirstCandidate: true,
      hasVersion: true,
      qaEnabled: true,
      hasReport: true,
      hasConclusion: false,
    })
    eq(acceptance.currentKey, 'acceptance', '验收阶段')
    eq(acceptance.stages[3].status, 'done', '测试已完成')
    eq(acceptance.stages[4].status, 'running', '验收进行中')
  })

  test('U30', '阶段映射：完成显示版本与得分，失败/停止不误显示完成', () => {
    const done = deriveStageProgress({
      runStatus: 'done',
      steps: stageSteps({ plan: 'done', generate: 'done', qa: 'done', review: 'done', deliver: 'done' }),
      hasFirstCandidate: true,
      hasVersion: true,
      qaEnabled: true,
      hasReport: true,
      hasConclusion: true,
      version: { seq: 1, score: 100 },
    })
    eq(done.overall, 'done', '整体完成')
    eq(done.currentKey, 'done', '当前完成')
    eq(done.summary, '完成 · v1 · 100 分', '完成摘要')
    assert(done.stages.every((s) => s.status === 'done'), '六阶段全部完成')
    const failed = deriveStageProgress({
      runStatus: 'failed',
      steps: stageSteps({ plan: 'done', generate: 'done' }),
      hasFirstCandidate: false,
      hasVersion: false,
      qaEnabled: null,
      hasReport: false,
      hasConclusion: false,
      error: '所有候选均生成失败',
    })
    eq(failed.overall, 'failed', '整体失败')
    eq(failed.summary, '失败', '失败摘要')
    assert(failed.stages[5].status !== 'done', '不能把完成标为已完成')
    const stopped = deriveStageProgress({
      runStatus: 'stopped',
      steps: stageSteps({ plan: 'done', generate: 'running' }),
      hasFirstCandidate: false,
      hasVersion: false,
      qaEnabled: null,
      hasReport: false,
      hasConclusion: false,
    })
    eq(stopped.overall, 'stopped', '整体停止')
    eq(stopped.summary, '已停止', '停止摘要')
    assert(stopped.stages[5].status !== 'done', '停止不能标为完成')
  })

  test('U31', '阶段映射：QA 关闭时测试标跳过并直接进入验收', () => {
    const p = deriveStageProgress({
      runStatus: 'running',
      steps: stageSteps({ plan: 'done', generate: 'done', review: 'running' }),
      hasFirstCandidate: true,
      hasVersion: true,
      qaEnabled: false,
      hasReport: false,
      hasConclusion: false,
    })
    eq(p.currentKey, 'acceptance', '当前验收')
    eq(p.stages[3].status, 'skipped', '测试跳过')
    assert(!p.stages[3].statusLabel.includes('进行中'), '不应卡在测试中')
  })

  test('U32', '阶段映射：历史已完成项目显示完成，旧项目 QA 标跳过', () => {
    const p = deriveStageProgress({
      runStatus: 'idle',
      steps: {},
      hasFirstCandidate: true,
      hasVersion: true,
      qaEnabled: null,
      hasReport: true,
      hasConclusion: true,
      version: { seq: 2, score: 92 },
      completedQa: 'skipped',
    })
    eq(p.overall, 'done', '整体完成')
    eq(p.summary, '完成 · v2 · 92 分', '完成摘要')
    eq(p.stages[3].status, 'skipped', '无 QA 历史项目标跳过')
  })

  console.log(`\n[unit] 合计 ${total} 项，通过 ${passed} 项，失败 ${total - passed} 项`)
  if (failures.length) {
    console.log('[unit] 失败清单：')
    for (const f of failures) console.log(`  - ${f.id} ${f.name}: ${f.error}`)
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[unit] 运行异常：', err)
  process.exit(1)
})
