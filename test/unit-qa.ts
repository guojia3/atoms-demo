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
