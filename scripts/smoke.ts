import { buildBaseline, compareWithBaseline, mergeRanges } from '../src/lib/baseline'
import { ipToInt, parseCidr, prefixForHosts } from '../src/lib/ip'
import { plan } from '../src/lib/planner'
import {
  blocksCoverExactly,
  selectableSegments,
  summarizeRoutes,
} from '../src/lib/summarize'
import type { PlannerInput, RouteSummaryBlock, SummaryMember } from '../src/lib/types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

// 1) 容量换算
check('2 台主机 -> /30', prefixForHosts(2) === 30)
check('3 台主机 -> /29', prefixForHosts(3) === 29)
check('100 台主机 -> /25', prefixForHosts(100) === 25)
check('254 台主机 -> /24', prefixForHosts(254) === 24)
check('255 台主机 -> /23', prefixForHosts(255) === 23)

// 2) 示例场景：保留 0/28，固定 64/28；自动 100/40/25/2
const demo: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const r = plan(demo)
check('示例无输入错误', r.inputErrors.length === 0, JSON.stringify(r.inputErrors))
check('示例无失败需求', r.failures.length === 0, JSON.stringify(r.failures))
const auto = r.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)
check(
  '自动分配结果正确（按地址顺序）',
  JSON.stringify(auto) === JSON.stringify(['192.168.10.16/30', '192.168.10.64/26', '192.168.10.128/25']),
  JSON.stringify(auto),
)
check('总地址守恒 256', r.summary.reserved + r.summary.fixed + r.summary.auto + r.summary.free === 256)
check('示例浪费量=53', r.summary.waste === 53, String(r.summary.waste))
check('示例空闲=12（20–31 + 192–255）', r.summary.free === 12, String(r.summary.free))

// 2b) 回归：保留 0/28、固定 64/28，/26 需求必须推进到 128（不能压在固定段上）
const reg: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'f', name: '固定', hosts: 2, cidr: '192.168.10.64/28' },
    { id: 'a', name: '自动', hosts: 40, cidr: '' },
  ],
}
const rr = plan(reg)
check(
  '对齐推进不侵占固定段',
  rr.segments.find((s) => s.kind === 'auto')?.cidr === '192.168.10.128/26',
  JSON.stringify(rr.segments.map((s) => [s.kind, s.cidr])),
)
check(
  '占用段之间无重叠',
  (() => {
    const occ2 = rr.segments.filter((s) => s.kind !== 'free').sort((a, b) => a.start - b.start)
    for (let i = 1; i < occ2.length; i++) if (occ2[i].start <= occ2[i - 1].end) return false
    return true
  })(),
)

// 3) 同规模按录入顺序：/28 保留外，3 个 /30 需求依次落到 16、20、24
const tie: PlannerInput = {
  parentCidr: '10.0.0.0/27',
  reservations: [{ id: 'r1', name: 'res', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
  ],
}
const rt = plan(tie)
check(
  '同规模按录入顺序分配',
  JSON.stringify(rt.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.16/30', '10.0.0.20/30', '10.0.0.24/30']),
  JSON.stringify(rt.segments),
)

// 4) 放不下：父 /30，需求 100 台，应给出原因
const tooBig: PlannerInput = {
  parentCidr: '192.168.0.0/30',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
}
const rb = plan(tooBig)
check('超大需求失败且有原因', rb.failures.length === 1 && /最大连续空闲块/.test(rb.failures[0].reason), rb.failures[0]?.reason)

// 5) 碎片化：/30 块被保留区切碎，大网段找不到对齐空间
const frag: PlannerInput = {
  parentCidr: '10.1.0.0/26',
  reservations: [
    { id: 'r1', name: 'r1', cidr: '10.1.0.16/30' },
    { id: 'r2', name: 'r2', cidr: '10.1.0.32/30' },
    { id: 'r3', name: 'r3', cidr: '10.1.0.48/30' },
  ],
  requirements: [{ id: 'x', name: '大块', hosts: 20, cidr: '' }], // 需要 /27
}
const rf = plan(frag)
check('碎片场景 /27 无法分配', rf.failures.length === 1, JSON.stringify(rf.failures))
check('失败后其余段仍正常输出', rf.segments.filter((s) => s.kind === 'reserved').length === 3)

// 6) 固定网段超出父网段 -> 输入错误
const outside: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.2.0/30' }],
}
check('固定网段越界报错', plan(outside).inputErrors.some((e) => /不在父网段/.test(e)))

// 7) 保留区与固定网段重叠 -> 输入错误
const overlap: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [{ id: 'r', name: 'R', cidr: '192.168.1.0/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.1.8/30' }],
}
check('保留与固定重叠报错', plan(overlap).inputErrors.some((e) => /重叠/.test(e)))

// 8) 固定网段容量不足 -> 报错并显示实际可用数
const small: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 20, cidr: '192.168.1.0/28' }],
}
check('固定段容量不足报错', plan(small).inputErrors.some((e) => /仅提供 14/.test(e)))

// 9) 非规范网络地址（主机位非 0）报错
const nonCanonical: PlannerInput = {
  parentCidr: '192.168.1.10/24',
  reservations: [],
  requirements: [],
}
check('非规范父网段报错并提示正确写法', plan(nonCanonical).inputErrors.some((e) => /192\.168\.1\.0\/24/.test(e)))

// 10) 自动网段绕开保留区且边界对齐：保留区位于中间 16/28，/27 需求应落到 0/27 而非 32/27？
//  最低对齐：0/27 空闲可容纳 -> 0/27
const align: PlannerInput = {
  parentCidr: '10.2.0.0/26',
  reservations: [{ id: 'r', name: 'R', cidr: '10.2.0.16/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 25, cidr: '' }], // /27
}
const ra = plan(align)
check(
  '最低对齐原则（跳过保留区取 32/27）',
  ra.segments.find((s) => s.kind === 'auto')?.cidr === '10.2.0.32/27',
  JSON.stringify(ra.segments.map((s) => s.cidr)),
)

// 11) 浪费量统计：100 台在 /25 浪费 26；广播/网络/可用范围正确
const w = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
})
const seg0 = w.segments.find((s) => s.kind === 'auto')!
check('浪费量=26', seg0.waste === 26, String(seg0.waste))
check('网络地址', seg0.network === '192.168.10.0')
check('广播地址', seg0.broadcast === '192.168.10.127')
check('可用范围', seg0.firstUsable === '192.168.10.1' && seg0.lastUsable === '192.168.10.126')
check('容量 128 / 可用 126', seg0.capacity === 128 && seg0.usable === 126)

// 12) 排序：录入小需求在前、大需求在后，大需求仍先分且不会被小需求挡住最低地址
const order: PlannerInput = {
  parentCidr: '172.16.0.0/24',
  reservations: [],
  requirements: [
    { id: 's', name: '小', hosts: 2, cidr: '' },
    { id: 'b', name: '大', hosts: 100, cidr: '' },
  ],
}
const ro = plan(order)
check(
  '大需求优先占最低对齐地址',
  JSON.stringify(ro.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['172.16.0.0/25', '172.16.0.128/30']),
  JSON.stringify(ro.segments.map((s) => s.cidr)),
)

// 13) 基线对比：按稳定 ID 识别新增/删除/未变/扩容/缩容/迁移/未分配/恢复分配
//  基线布局（10.0.0.0/24）：固定 q3 .32/28；q1(100台,/25) .128–.255；q2(40台,/26) .64–.127
const baseInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const basePlan = plan(baseInput)
check('基线场景无输入错误', basePlan.inputErrors.length === 0, JSON.stringify(basePlan.inputErrors))
check(
  '基线布局：q1=.128/25、q2=.64/26、q3=.32/28',
  JSON.stringify(basePlan.segments.filter((s) => s.kind !== 'free').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.32/28', '10.0.0.64/26', '10.0.0.128/25']),
  JSON.stringify(basePlan.segments.map((s) => s.cidr)),
)
const baseline = buildBaseline(basePlan)
check(
  '基线包含全部 3 个已分配需求',
  baseline.entries.length === 3 && baseline.entries.every((e) => e.state === 'allocated'),
)

// 13a) 相同输入 -> 全部未变、净变化 0
const same = compareWithBaseline(baseline, plan(baseInput))
check('相同规划全部未变', same.counts.unchanged === 3 && same.hasChanges === false)
check('相同规划净变化为 0', same.summary.net === 0)
check(
  '相同规划仍占用=基线占用，新占用/释放为 0',
  same.summary.occupiedCount === 0 &&
    same.summary.releasedCount === 0 &&
    same.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13b) 纯新增：简单基线 q1(100)=0/25、q2(40)=128/26，再加 q4(2 台)
//  q1/q2 位置不变，q4 落到最低空闲 .192/30 -> 新占用 4、释放 0、净 +4
const simpleBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    ],
  }),
)
const addPlan = plan({
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
  ],
})
const dAdd = compareWithBaseline(simpleBase, addPlan)
check('纯新增：added=1、unchanged=2', dAdd.counts.added === 1 && dAdd.counts.unchanged === 2)
check('新增段 q4 在 192/30', dAdd.rows.find((r) => r.id === 'q4')?.current?.cidr === '10.0.0.192/30')
check(
  '纯新增：新占用 4、释放 0、仍占用 192、净 +4，且无重复计数',
  dAdd.summary.occupiedCount === 4 &&
    dAdd.summary.releasedCount === 0 &&
    dAdd.summary.stillCount === 192 &&
    dAdd.summary.net === 4 &&
    dAdd.summary.occupiedCount + dAdd.summary.stillCount === addPlan.summary.usedCapacity,
  JSON.stringify({
    occ: dAdd.summary.occupiedCount,
    rel: dAdd.summary.releasedCount,
    still: dAdd.summary.stillCount,
  }),
)

// 13b2) 纯删除：去掉 q2 -> q1 未变，q2 删除，释放 .128–.191 共 64
const dRm = compareWithBaseline(
  simpleBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '办公', hosts: 100, cidr: '' }],
  }),
)
check(
  '纯删除：removed=1、unchanged=1，释放 64、新占用 0、净 −64',
  dRm.counts.removed === 1 &&
    dRm.rows.find((r) => r.id === 'q2')?.type === 'removed' &&
    dRm.rows.find((r) => r.id === 'q1')?.type === 'unchanged' &&
    dRm.summary.releasedCount === 64 &&
    dRm.summary.occupiedCount === 0 &&
    dRm.summary.net === -64,
  JSON.stringify({
    rel: dRm.summary.releasedCount,
    occ: dRm.summary.occupiedCount,
  }),
)

// 13b3) 删除固定段 q3 并新增 q4：固定段在 32/28，删除后空闲地址上移，q1/q2 重排（迁移）
const reshuffle = compareWithBaseline(
  baseline,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
      { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
    ],
  }),
)
check(
  '删固定段引发重排：q3 删除、q4 新增、q1/q2 迁移',
  reshuffle.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    reshuffle.rows.find((r) => r.id === 'q4')?.type === 'added' &&
    reshuffle.rows.find((r) => r.id === 'q1')?.type === 'migrated' &&
    reshuffle.rows.find((r) => r.id === 'q2')?.type === 'migrated',
  JSON.stringify(reshuffle.rows.map((r) => [r.id, r.type])),
)

// 13c) q1 缩容（100→60 台，/25→/26）后与 q2 互换位置：CIDR 改变=迁移，且标记缩容
const shrunk: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 60, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const ds = compareWithBaseline(baseline, plan(shrunk))
const q1s = ds.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 缩容（128/25 -> 64/26）',
  q1s?.type === 'migrated' &&
    q1s.resize === 'shrink' &&
    q1s.baseline?.cidr === '10.0.0.128/25' &&
    q1s.current?.cidr === '10.0.0.64/26',
  JSON.stringify(q1s),
)
const q2s = ds.rows.find((r) => r.id === 'q2')
check('q2 也迁移（64/26 -> 128/26，容量不变不标扩缩容）', q2s?.type === 'migrated' && q2s.resize === undefined)
check('q3 固定段未变', ds.rows.find((r) => r.id === 'q3')?.type === 'unchanged')

// 13d) q1 扩容（100→200 台，/25→/24）：CIDR 改变=迁移且标记扩容
const growBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
const dg = compareWithBaseline(
  growBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 200, cidr: '' }],
  }),
)
const q1g = dg.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 扩容（0/25 -> 0/24，128->256）',
  q1g?.type === 'migrated' &&
    q1g.resize === 'grow' &&
    q1g.baseline?.cidr === '10.0.0.0/25' &&
    q1g.current?.cidr === '10.0.0.0/24',
  JSON.stringify(q1g),
)
check('扩容净变化 +128（新占用 .128–.255，无释放）', dg.summary.net === 128 && dg.summary.releasedCount === 0)

// 13e) 碎片化保留区：q1(/25) 无处可放，q2(/26) 迁到 .128，q3 被删除
//  保留 .0/26 + .64/27 堵死低端对齐点，保留 .192/26 切碎原 q1 空间（三段互不重叠）
const squeezed: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [
    { id: 'r1', name: '保留A', cidr: '10.0.0.0/26' },
    { id: 'r2', name: '保留B', cidr: '10.0.0.64/27' },
    { id: 'r3', name: '保留C', cidr: '10.0.0.192/26' },
  ],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
  ],
}
check('挤压场景无输入错误（q1 预期失败）', plan(squeezed).inputErrors.length === 0)
const dq = compareWithBaseline(baseline, plan(squeezed))
check(
  '碎片化：q1 未分配、q2 迁移到 .128/26、q3 删除，且释放地址非 0',
  dq.rows.find((r) => r.id === 'q2')?.type === 'migrated' &&
    dq.rows.find((r) => r.id === 'q2')?.current?.cidr === '10.0.0.128/26' &&
    dq.rows.find((r) => r.id === 'q1')?.type === 'unallocated' &&
    dq.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    dq.summary.releasedCount > 0,
  JSON.stringify(dq.rows.map((r) => [r.id, r.type, r.current?.cidr])),
)
// 地址守恒（同父网段）：净变化 = 当前占用 - 基线占用（含保留区变化）
check(
  '挤压场景地址守恒',
  dq.summary.occupiedCount + dq.summary.stillCount === plan(squeezed).summary.usedCapacity &&
    dq.summary.releasedCount + dq.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13f) 未分配与恢复分配
const tight: PlannerInput = {
  parentCidr: '192.168.10.0/28',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
  requirements: [
    { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
    { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
  ],
}
const tightPlan = plan(tight)
check('拥挤场景 q1 失败、q9 成功', tightPlan.failures.some((f) => f.id === 'q1') && tightPlan.failures.length === 1)
const tightBaseline = buildBaseline(tightPlan)
check('基线可包含失败需求（未分配）', tightBaseline.entries.find((e) => e.id === 'q1')?.state === 'unallocated')
const dRec = compareWithBaseline(
  tightBaseline,
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
      { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
    ],
  }),
)
check('未分配 -> 已分配 标记为恢复分配', dRec.rows.find((r) => r.id === 'q1')?.type === 'recovered')
const dFail = compareWithBaseline(
  buildBaseline(
    plan({
      parentCidr: '192.168.10.0/24',
      reservations: [],
      requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
    }),
  ),
  plan({
    parentCidr: '192.168.10.0/28',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
check('已分配 -> 失败 标记为未分配', dFail.rows.find((r) => r.id === 'q1')?.type === 'unallocated')

// 13g) 区间工具：重叠/相邻合并，重叠部分不重复计数
const mr = mergeRanges([
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.0.0.9') },
  { start: ipToInt('10.0.0.5'), end: ipToInt('10.0.0.20') },
  { start: ipToInt('10.0.0.21'), end: ipToInt('10.0.0.30') },
])
check(
  '区间合并去重（相交+相邻）',
  mr.length === 1 && mr[0].start === ipToInt('10.0.0.0') && mr[0].end === ipToInt('10.0.0.30'),
  JSON.stringify(mr),
)

// 14) 路由汇总（CIDR 聚合）
function member(id: string, cidr: string, name = id, kind: 'fixed' | 'auto' = 'auto'): SummaryMember {
  const p = parseCidr(cidr)
  if ('error' in p) throw new Error(p.error)
  return { id, name, kind, cidr, prefix: p.prefix, start: p.network, end: p.broadcast }
}
const cidrsOf = (bs: RouteSummaryBlock[]) => bs.map((b) => b.cidr)
function toMemberFromSegment(s: ReturnType<typeof selectableSegments>[number]): SummaryMember {
  return {
    id: s.ownerId,
    name: s.name,
    kind: s.kind,
    cidr: s.cidr,
    prefix: s.prefix,
    start: s.start,
    end: s.end,
  }
}

// 14a) 单个网段原样返回
check(
  '汇总：单个 /28 原样返回',
  JSON.stringify(cidrsOf(summarizeRoutes([member('a', '10.0.0.0/28')]))) ===
    JSON.stringify(['10.0.0.0/28']),
)

// 14b) 两个同前缀、连续且同属一个上级网段 -> 聚合
check(
  '汇总：相邻同上级 /30 聚合成 /29',
  JSON.stringify(cidrsOf(summarizeRoutes([member('a', '10.0.0.0/30'), member('b', '10.0.0.4/30')]))) ===
    JSON.stringify(['10.0.0.0/29']),
)

// 14c) 连续但分属不同上级网段 -> 不得聚合
check(
  '汇总：4/30 与 8/30 分属不同 /29，不聚合',
  JSON.stringify(cidrsOf(summarizeRoutes([member('a', '10.0.0.4/30'), member('b', '10.0.0.8/30')]))) ===
    JSON.stringify(['10.0.0.4/30', '10.0.0.8/30']),
)

// 14d) 中间有空闲间隙 -> 不得跨越聚合
check(
  '汇总：0/30 与 8/30 间隔空闲，不聚合',
  JSON.stringify(cidrsOf(summarizeRoutes([member('a', '10.0.0.0/30'), member('b', '10.0.0.8/30')]))) ===
    JSON.stringify(['10.0.0.0/30', '10.0.0.8/30']),
)

// 14e) 三个连续 /30（8 地址区间）-> /29 + /30，数量最少且不越界
check(
  '汇总：三个连续 /30 -> /29 + /30（无 /31）',
  JSON.stringify(cidrsOf(summarizeRoutes([
    member('a', '10.0.0.0/30'),
    member('b', '10.0.0.4/30'),
    member('c', '10.0.0.8/30'),
  ]))) === JSON.stringify(['10.0.0.0/29', '10.0.0.8/30']),
)

// 14f) 四个连续 /30 -> 单个 /28
check(
  '汇总：四个连续 /30 -> /28',
  JSON.stringify(cidrsOf(summarizeRoutes([
    member('a', '10.0.0.0/30'),
    member('b', '10.0.0.4/30'),
    member('c', '10.0.0.8/30'),
    member('d', '10.0.0.12/30'),
  ]))) === JSON.stringify(['10.0.0.0/28']),
)

// 14g) 跨边界的大量连续 /30：0/28 + 32/27 合并为 32-3=32，0..31 单独 /27
//  选 0/28（16）+ 16/30（4）+ 32/27（32）= 0..19 与 32..63
check(
  '汇总：非 2 幂长度区间按对齐边界拆分（/28 + /30）',
  JSON.stringify(cidrsOf(summarizeRoutes([
    member('a', '10.0.0.0/28'),
    member('b', '10.0.0.16/30'),
    member('c', '10.0.0.32/27'),
  ]))) === JSON.stringify(['10.0.0.0/28', '10.0.0.16/30', '10.0.0.32/27']),
)

// 14h) 覆盖精确性：任何汇总 CIDR 都不得包含未选地址（空闲/保留）
//  父 /24 中保留 0/28，选 16/30 与 32/27（中间 20–31 空闲），结果不得跨越间隙
const gapCase = summarizeRoutes([member('a', '192.168.10.16/30'), member('b', '192.168.10.32/27')])
check(
  '汇总：跨越空闲间隙不得聚合成 16/27',
  JSON.stringify(cidrsOf(gapCase)) === JSON.stringify(['192.168.10.16/30', '192.168.10.32/27']),
  JSON.stringify(cidrsOf(gapCase)),
)
{
  const chosen = mergeRanges(gapCase.flatMap((b) => b.members.map((m) => ({ start: m.start, end: m.end }))))
  const noOverreach = gapCase.every((b) =>
    chosen.some((r) => b.network >= r.start && b.network + b.size - 1 <= r.end),
  )
  check('汇总：每个 CIDR 完全落在所选并集内（无越界覆盖）', noOverreach)
  check('汇总：总地址数与所选一致', blocksCoverExactly(gapCase, gapCase.flatMap((b) => b.members)))
}

// 14i) 示例规划全选：保留 0/28 不参与；自动 16/30、64/26、128/25 + 固定 32/27
//  固定 32/27 + 自动 64/26 连续成 96 地址区间，但 32 仅对齐到 /27，
//  故最省拆分是 32/27 + 64/26（32/26 不是合法对齐网络地址）
{
  const segMembers = selectableSegments(plan(demo)).map((s) => toMemberFromSegment(s))
  const all = summarizeRoutes(segMembers)
  check(
    '示例全选：16/30 独立、32–127 拆为 32/27+64/26、128/25',
    JSON.stringify(cidrsOf(all)) ===
      JSON.stringify(['192.168.10.16/30', '192.168.10.32/27', '192.168.10.64/26', '192.168.10.128/25']),
    JSON.stringify(cidrsOf(all)),
  )
  check('示例全选：地址总数=228（固定32+自动196），与各块之和相等', blocksCoverExactly(all, segMembers))
  // 不得覆盖保留区 0..15 与唯一空闲间隙 20..31（128/25 已覆盖 192..255，属已选）
  const forbidden = [
    { start: ipToInt('192.168.10.0'), end: ipToInt('192.168.10.15') },
    { start: ipToInt('192.168.10.20'), end: ipToInt('192.168.10.31') },
  ]
  const touchesForbidden = all.some((b) =>
    forbidden.some((f) => b.network <= f.end && b.network + b.size - 1 >= f.start),
  )
  check('示例全选：汇总块不覆盖保留区与空闲区', !touchesForbidden)
}

// 14j) 部分选择：相邻的两个块只选其一，不得聚合
check(
  '汇总：只选相邻对的一个（64/26 不选 32/27）',
  JSON.stringify(cidrsOf(summarizeRoutes([member('b', '192.168.10.64/26')]))) ===
    JSON.stringify(['192.168.10.64/26']),
)

// 14k) 结果按网络地址升序，即便输入乱序
check(
  '汇总：输出按网络地址升序',
  JSON.stringify(cidrsOf(summarizeRoutes([
    member('c', '10.0.0.32/27'),
    member('a', '10.0.0.0/30'),
    member('b', '10.0.0.4/30'),
  ]))) === JSON.stringify(['10.0.0.0/29', '10.0.0.32/27']),
)

// 14l) 可选网段只含成功分配的固定/自动（保留区、空闲、失败需求均排除）
{
  const withFail: PlannerInput = {
    parentCidr: '192.168.10.0/28',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
    requirements: [
      { id: 'big', name: '大需求', hosts: 100, cidr: '' },
      { id: 'ok', name: '小需求', hosts: 2, cidr: '' },
    ],
  }
  const wf = plan(withFail)
  const ids = selectableSegments(wf).map((s) => s.ownerId)
  check(
    '可选网段排除保留/空闲/失败需求，仅保留成功分配项',
    JSON.stringify(ids) === JSON.stringify(['ok']) && wf.failures.some((f) => f.id === 'big'),
    JSON.stringify(ids),
  )
}

// 14m) 成员信息透传：聚合块记录覆盖的原需求（名称与原 CIDR）
{
  const bs = summarizeRoutes([
    member('a', '10.0.0.0/30', '链路A'),
    member('b', '10.0.0.4/30', '链路B'),
  ])
  const memberIds = bs[0].members.map((m) => m.id).sort()
  check('汇总块记录全部被覆盖原需求', bs.length === 1 && JSON.stringify(memberIds) === JSON.stringify(['a', 'b']))
}

// 14n) 随机属性测试：在 /24 内随机取若干 /30 网格块，汇总结果必须
//  （a）与所选并集逐地址相等、（b）块数等于回溯法求得的最小可能块数
{
  // 确定性伪随机（LCG）
  let seed = 0x1234abcd
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 0x80000000
    return seed / 0x80000000
  }
  // 回溯 + 记忆化：在连续区间 [start,end]（相对 /24 起点，均 4 对齐）内
  // 枚举起点处所有合法且不越界的 CIDR，求最少块数
  const minBlocks = (start: number, end: number): number => {
    const memo = new Map<number, number>()
    const go = (cursor: number): number => {
      if (cursor > end) return 0
      const cached = memo.get(cursor)
      if (cached !== undefined) return cached
      let best = Infinity
      for (let p = 30; p >= 24; p--) {
        const size = 2 ** (32 - p)
        if (cursor % size !== 0) continue
        if (cursor + size - 1 > end) continue
        best = Math.min(best, 1 + go(cursor + size))
      }
      memo.set(cursor, best)
      return best
    }
    return go(start)
  }
  let trials = 0
  let optimal = true
  let exactAll = true
  const base = ipToInt('172.20.5.0')
  for (let t = 0; t < 200; t++) {
    const chosen: SummaryMember[] = []
    for (let i = 0; i < 64; i++) {
      if (rnd() < 0.4) {
        chosen.push(member(`m${i}`, `172.20.5.${i * 4}/30`))
      }
    }
    if (chosen.length === 0) continue
    trials++
    const blocks = summarizeRoutes(chosen)
    if (!blocksCoverExactly(blocks, chosen)) exactAll = false
    // 合并相邻区间后逐段对比理论最小块数（所有区间相对 /24 起点仍保持对齐）
    const ranges = mergeRanges(chosen.map((m) => ({ start: m.start, end: m.end })))
    const theoretical = ranges.reduce((acc, r) => acc + minBlocks(r.start - base, r.end - base), 0)
    if (blocks.length !== theoretical) {
      optimal = false
      break
    }
  }
  check(`随机最优性（${trials} 组，块数均为最小）`, optimal && trials > 0, `trials=${trials}`)
  check('随机精确覆盖（并集逐地址相等，无遗漏/越界）', exactAll)
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 个测试失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
