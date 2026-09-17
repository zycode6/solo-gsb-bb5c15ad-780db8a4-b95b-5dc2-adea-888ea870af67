import { formatCidr } from './ip'
import type {
  PlanResult,
  RouteSummaryBlock,
  Segment,
  SummaryMember,
} from './types'

/** 已成功分配的需求网段（固定/自动，必然带 ownerId） */
export type AllocatedSegment = Segment & {
  kind: 'fixed' | 'auto'
  ownerId: string
}

/** 从规划结果中取出全部成功分配的固定/自动需求网段（按地址升序） */
export function selectableSegments(result: PlanResult): AllocatedSegment[] {
  return result.segments
    .filter((s): s is AllocatedSegment =>
      (s.kind === 'fixed' || s.kind === 'auto') && Boolean(s.ownerId),
    )
    .sort((a, b) => a.start - b.start)
}

/**
 * 将所选需求网段的并集转换为数量最少且覆盖精确的 CIDR 列表。
 *
 * 规则：
 * 1. 先把相交或相邻的所选区间合并为连续区间（所选段互不重叠，但可能相邻）；
 * 2. 对每个连续区间从最低地址开始，取「不超出区间末端」的最大对齐 CIDR 块；
 *    这等价于只在「两个同前缀、连续且同属一个上级网段的块」都被选中时才聚合，
 *    因此任何汇总块都不会包含未选需求、保留区或空闲地址；
 * 3. 结果按网络地址升序返回。
 */
export function summarizeRoutes(membersInput: SummaryMember[]): RouteSummaryBlock[] {
  if (membersInput.length === 0) return []

  // 以 [start,end] 为键去重（同一需求不会重复，防御性处理），并按地址升序
  const members = [...membersInput].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number; members: SummaryMember[] }[] = []
  for (const m of members) {
    const last = merged[merged.length - 1]
    if (last && m.start <= last.end + 1) {
      // 重叠时不重复挂成员；相邻或包含都并入同一连续区间
      if (!last.members.some((x) => x.id === m.id)) last.members.push(m)
      last.end = Math.max(last.end, m.end)
    } else {
      merged.push({ start: m.start, end: m.end, members: [m] })
    }
  }

  const blocks: RouteSummaryBlock[] = []
  for (const range of merged) {
    let cursor = range.start
    while (cursor <= range.end) {
      // 地址允许的最大对齐块：由起始地址末尾的 0 位决定（0 可对齐整块 IPv4）
      const alignSize = cursor === 0 ? 0x100000000 : (cursor & -cursor) >>> 0
      // 不超过区间剩余长度的最大 2 的幂
      const remaining = range.end - cursor + 1
      const size = Math.min(alignSize, largestPowerOfTwo(remaining))
      const prefix = 32 - Math.log2(size)

      // 记录该 CIDR 实际覆盖的原需求（成员区间均落在所选并集内）
      const covered = range.members.filter((m) => m.start <= cursor + size - 1 && m.end >= cursor)

      blocks.push({
        cidr: formatCidr(cursor >>> 0, prefix),
        network: cursor >>> 0,
        prefix,
        size,
        members: covered,
      })
      cursor = (cursor + size) >>> 0
    }
  }

  blocks.sort((a, b) => a.network - b.network || a.prefix - b.prefix)
  return blocks
}

function largestPowerOfTwo(n: number): number {
  let p = 1
  while (p * 2 <= n && p < 0x100000000) p *= 2
  return p
}

/** 汇总结果总地址数 */
export function totalSizeOf(blocks: RouteSummaryBlock[]): number {
  return blocks.reduce((acc, b) => acc + b.size, 0)
}

/** 校验汇总块确实与所选并集完全一致（无遗漏、无越界），供测试与自检使用 */
export function blocksCoverExactly(
  blocks: RouteSummaryBlock[],
  members: SummaryMember[],
): boolean {
  const cover = blocks.reduce((acc, b) => acc + b.size, 0)
  const selected = members.reduce((acc, m) => acc + (m.end - m.start + 1), 0)
  return cover === selected
}
