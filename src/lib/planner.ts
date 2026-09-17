import {
  alignTo,
  blockSize,
  formatCidr,
  intToIp,
  parseCidr,
  prefixForHosts,
  type ParsedCidr,
} from './ip'
import type {
  FailureItem,
  PlanResult,
  PlannerInput,
  RequirementInput,
  ReservedInput,
  Segment,
} from './types'

interface Interval {
  start: number
  end: number
}

interface Occupied extends Interval {
  kind: 'reserved' | 'fixed' | 'auto'
  name: string
  prefix: number
  network: number
  requestedHosts?: number
  ownerId?: string
}

interface Gap extends Interval {
  length: number
}

/** 计算已占用区间之外、按父网段边界裁剪后的全部空闲间隙（按地址升序） */
function computeGaps(parentStart: number, parentEnd: number, occupied: Interval[]): Gap[] {
  const sorted = [...occupied].sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps: Gap[] = []
  let cursor = parentStart
  for (const iv of sorted) {
    if (iv.end < cursor) continue // 完全包含在已处理区间内
    const start = Math.max(cursor, iv.start)
    if (start > cursor) {
      gaps.push({ start: cursor, end: start - 1, length: start - cursor })
    }
    cursor = Math.max(cursor, iv.end + 1)
    if (cursor > parentEnd) break
  }
  if (cursor <= parentEnd) {
    gaps.push({ start: cursor, end: parentEnd, length: parentEnd - cursor + 1 })
  }
  return gaps
}

function usableOf(size: number): number {
  return size >= 4 ? size - 2 : 0
}

function describeRange(network: number, size: number, broadcast: number) {
  if (size < 4) {
    // /31、/32 无标准意义上的可用主机地址
    return { firstUsable: '—', lastUsable: '—', usable: 0 }
  }
  return {
    firstUsable: intToIp(network + 1),
    lastUsable: intToIp(broadcast - 1),
    usable: size - 2,
  }
}

function toSegment(oc: Occupied): Segment {
  const size = blockSize(oc.prefix)
  const broadcast = oc.prefix === 32 ? oc.network : oc.network + size - 1
  const { firstUsable, lastUsable, usable } = describeRange(oc.network, size, broadcast)
  const waste =
    oc.requestedHosts !== undefined ? Math.max(0, usable - oc.requestedHosts) : 0
  return {
    kind: oc.kind,
    name: oc.name,
    cidr: formatCidr(oc.network, oc.prefix),
    prefix: oc.prefix,
    network: intToIp(oc.network),
    broadcast: intToIp(broadcast),
    firstUsable,
    lastUsable,
    start: oc.network,
    end: broadcast,
    capacity: size,
    usable,
    waste,
    requestedHosts: oc.requestedHosts,
    ownerId: oc.ownerId,
  }
}

function freeSegment(gap: Gap): Segment {
  return {
    kind: 'free',
    name: '空闲',
    cidr: `${intToIp(gap.start)} – ${intToIp(gap.end)}`,
    prefix: -1,
    network: intToIp(gap.start),
    broadcast: intToIp(gap.end),
    firstUsable: '—',
    lastUsable: '—',
    start: gap.start,
    end: gap.end,
    capacity: gap.length,
    usable: gap.length,
    waste: 0,
  }
}

function overlap(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end
}

interface ParsedFixed {
  req: RequirementInput
  parsed: ParsedCidr
  hosts: number
}

export function plan(input: PlannerInput): PlanResult {
  const inputErrors: string[] = []
  const occupied: Occupied[] = []

  // 1) 解析并校验父网段
  const parentRaw = input.parentCidr.trim()
  if (!parentRaw) {
    inputErrors.push('请填写父 CIDR（例如 192.168.1.0/24）')
  }
  const parentParsed = parentRaw ? parseCidr(parentRaw, true) : null
  if (parentParsed && 'error' in parentParsed) {
    inputErrors.push(`父网段无效：${parentParsed.error}`)
  }
  const parent = parentParsed && !('error' in parentParsed) ? parentParsed : null
  const parentStart = parent ? parent.network : 0
  const parentEnd = parent ? parent.broadcast : 0
  const parentSize = parent ? parent.size : 0

  const withinParent = (s: number, e: number) =>
    parent !== null && s >= parentStart && e <= parentEnd

  // 2) 解析保留区
  const reservedItems: { item: ReservedInput; parsed: ParsedCidr }[] = []
  for (const r of input.reservations) {
    if (!r.cidr.trim() && !r.name.trim()) continue
    if (!r.cidr.trim()) {
      inputErrors.push(`保留区“${r.name || '未命名'}”缺少 CIDR`)
      continue
    }
    const parsed = parseCidr(r.cidr, true)
    if ('error' in parsed) {
      inputErrors.push(`保留区“${r.name || r.cidr}”无效：${parsed.error}`)
      continue
    }
    if (parent && !withinParent(parsed.network, parsed.broadcast)) {
      inputErrors.push(
        `保留区“${r.name || r.cidr}”（${formatCidr(parsed.network, parsed.prefix)}）不在父网段 ${parentRaw} 内`,
      )
      continue
    }
    reservedItems.push({ item: r, parsed })
  }

  // 3) 解析需求：固定网段 vs 自动网段
  const fixedItems: ParsedFixed[] = []
  const autoItems: { req: RequirementInput; hosts: number }[] = []
  for (const req of input.requirements) {
    if (req.name.trim() === '' && req.hosts === '' && req.cidr.trim() === '') continue
    const label = req.name || '未命名需求'
    if (req.hosts === '' || !Number.isInteger(req.hosts) || req.hosts <= 0) {
      inputErrors.push(`需求“${label}”的主机数无效（需为大于 0 的整数）`)
      continue
    }
    const hosts = req.hosts
    if (req.cidr.trim() !== '') {
      const parsed = parseCidr(req.cidr, true)
      if ('error' in parsed) {
        inputErrors.push(`需求“${label}”的固定网段无效：${parsed.error}`)
        continue
      }
      if (parent && !withinParent(parsed.network, parsed.broadcast)) {
        inputErrors.push(
          `需求“${label}”的固定网段 ${formatCidr(parsed.network, parsed.prefix)} 不在父网段 ${parentRaw} 内`,
        )
        continue
      }
      const usable = usableOf(parsed.size)
      if (usable < hosts) {
        inputErrors.push(
          `需求“${label}”需要 ${hosts} 台主机，但固定网段 ${formatCidr(parsed.network, parsed.prefix)} 仅提供 ${usable} 个可用地址（总容量 ${parsed.size}）`,
        )
        continue
      }
      fixedItems.push({ req, parsed, hosts })
    } else {
      autoItems.push({ req, hosts })
    }
  }

  // 4) 保留区与固定网段两两互不重叠（任一非法即终止，避免区间不可信）
  if (parent) {
    const claims: { label: string; iv: Interval }[] = [
      ...reservedItems.map(({ item, parsed }) => ({
        label: `保留区“${item.name || formatCidr(parsed.network, parsed.prefix)}”`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
      ...fixedItems.map(({ req, parsed }) => ({
        label: `需求“${req.name || formatCidr(parsed.network, parsed.prefix)}”的固定网段`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
    ]
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        if (overlap(claims[i].iv, claims[j].iv)) {
          inputErrors.push(`${claims[i].label}与${claims[j].label}地址重叠`)
        }
      }
    }
  }

  if (!parent || inputErrors.length > 0) {
    return {
      parentCidr: parentRaw,
      parentNetwork: parent ? intToIp(parent.network) : '',
      parentPrefix: parent ? parent.prefix : -1,
      parentSize,
      segments: [],
      failures: [],
      inputErrors,
      summary: emptySummary(parent),
    }
  }

  // 占用区：保留区 + 固定网段
  for (const { item, parsed } of reservedItems) {
    occupied.push({
      kind: 'reserved',
      name: item.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      ownerId: item.id,
    })
  }
  for (const { req, parsed, hosts } of fixedItems) {
    occupied.push({
      kind: 'fixed',
      name: req.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }

  // 5) 自动需求：从大到小（前缀小者优先），同规模按录入顺序
  const orderedAuto = autoItems
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      const pa = prefixForHosts(a.hosts)
      const pb = prefixForHosts(b.hosts)
      return pa - pb || a.index - b.index
    })

  const failures: FailureItem[] = []
  for (const { req, hosts } of orderedAuto) {
    const prefix = prefixForHosts(hosts)
    const size = blockSize(prefix)
    const label = req.name || '未命名需求'

    if (size < hosts + 2) {
      failures.push({
        id: req.id,
        name: label,
        hosts,
        reason: `需要 ${hosts} 台主机，超过 IPv4 最大单网段可用容量 4294967294（/0）`,
      })
      continue
    }

    const gaps = computeGaps(parentStart, parentEnd, occupied)
    let placed: { start: number } | null = null
    for (const gap of gaps) {
      if (gap.length < size) continue
      // 间隙内第一个满足前缀边界对齐的地址（对齐结果若落在间隙之前则推进一个块）
      let alignedStart = alignTo(gap.start, prefix)
      if (alignedStart < gap.start) alignedStart += size
      if (alignedStart + size - 1 <= gap.end) {
        placed = { start: alignedStart >>> 0 }
        break // 最低对齐空闲地址（间隙已按地址升序）
      }
    }

    if (!placed) {
      const gapsNow = computeGaps(parentStart, parentEnd, occupied)
      const maxGap = gapsNow.reduce((m, g) => Math.max(m, g.length), 0)
      const reasons: string[] = []
      if (maxGap < size) {
        reasons.push(
          `需要至少 ${size} 个连续地址（/${prefix}，可用 ${usableOf(size)} 台），当前最大连续空闲块仅 ${maxGap} 个地址`,
        )
      } else {
        reasons.push(
          `空闲块虽有 ${maxGap} 个地址，但不存在满足 /${prefix} 边界对齐的 ${size} 地址空间`,
        )
      }
      failures.push({ id: req.id, name: label, hosts, reason: reasons.join('；') })
      continue
    }

    occupied.push({
      kind: 'auto',
      name: label,
      prefix,
      network: placed.start,
      start: placed.start,
      end: placed.start + size - 1,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }

  // 6) 生成最终网段序列（占用 + 空闲，按地址排序）
  const segments: Segment[] = []
  const occSegments = occupied.sort((a, b) => a.start - b.start).map(toSegment)
  const finalGaps = computeGaps(parentStart, parentEnd, occupied)
  let gi = 0
  for (const seg of occSegments) {
    while (gi < finalGaps.length && finalGaps[gi].end < seg.start) {
      segments.push(freeSegment(finalGaps[gi]))
      gi++
    }
    segments.push(seg)
  }
  while (gi < finalGaps.length) {
    segments.push(freeSegment(finalGaps[gi]))
    gi++
  }

  // 7) 统计
  const sumCapacity = (k: Segment['kind']) =>
    segments.filter((s) => s.kind === k).reduce((acc, s) => acc + s.capacity, 0)
  const reservedCap = sumCapacity('reserved')
  const fixedCap = sumCapacity('fixed')
  const autoCap = sumCapacity('auto')
  const freeCap = sumCapacity('free')
  const allocatedUsable = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.usable, 0)
  const requestedHosts = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + (s.requestedHosts ?? 0), 0)
  const waste = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.waste, 0)

  return {
    parentCidr: formatCidr(parent.network, parent.prefix),
    parentNetwork: intToIp(parent.network),
    parentPrefix: parent.prefix,
    parentSize,
    segments,
    failures,
    inputErrors,
    summary: {
      reserved: reservedCap,
      fixed: fixedCap,
      auto: autoCap,
      free: freeCap,
      totalCapacity: parentSize,
      usedCapacity: reservedCap + fixedCap + autoCap,
      allocatedUsable,
      requestedHosts,
      waste,
      utilization: parentSize === 0 ? 0 : ((reservedCap + fixedCap + autoCap) / parentSize) * 100,
    },
  }
}

function emptySummary(parent: ParsedCidr | null): PlanResult['summary'] {
  return {
    reserved: 0,
    fixed: 0,
    auto: 0,
    free: 0,
    totalCapacity: parent ? parent.size : 0,
    usedCapacity: 0,
    allocatedUsable: 0,
    requestedHosts: 0,
    waste: 0,
    utilization: 0,
  }
}
