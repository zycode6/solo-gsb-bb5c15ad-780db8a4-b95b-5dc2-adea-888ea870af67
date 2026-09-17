// 网段类型：保留区、固定网段（带固定前缀的需求）、自动分配网段、空闲区
export type SegmentKind = 'reserved' | 'fixed' | 'auto' | 'free'

export interface RequirementInput {
  id: string
  name: string
  /** 需要的可用主机数（= 总地址数 - 2） */
  hosts: number | ''
  /** 可选固定网段，形如 192.168.1.0/28 */
  cidr: string
}

export interface ReservedInput {
  id: string
  name: string
  /** 保留区 CIDR，形如 10.0.0.0/30 */
  cidr: string
}

export interface Segment {
  kind: SegmentKind
  /** 关联的需求 / 保留区名称（空闲区为“空闲”） */
  name: string
  cidr: string
  prefix: number
  network: string
  broadcast: string
  firstUsable: string
  lastUsable: string
  start: number // 起始地址（数值，含）
  end: number // 结束地址（数值，含）
  /** 地址块总容量 2^(32-prefix) */
  capacity: number
  /** 可用主机数 = capacity - 2 */
  usable: number
  /** 浪费量 = capacity - 2 - 实际需求主机数（自动网段）；保留/固定按容量统计 */
  waste: number
  requestedHosts?: number
  /** 自动分配失败时的原因 */
  reason?: string
  /** 关联的需求 ID（fixed/auto）或保留区 ID（reserved），用于基线对比 */
  ownerId?: string
}

export interface FailureItem {
  id: string
  name: string
  hosts: number
  reason: string
}

export interface PlanResult {
  parentCidr: string
  parentNetwork: string
  parentPrefix: number
  parentSize: number
  segments: Segment[]
  failures: FailureItem[]
  /** 输入级错误（父网段、保留区、固定网段非法等），非空时 segments 不可信 */
  inputErrors: string[]
  summary: {
    reserved: number
    fixed: number
    auto: number
    free: number
    totalCapacity: number
    usedCapacity: number
    allocatedUsable: number
    requestedHosts: number
    waste: number
    utilization: number // 已占用地址占父网段百分比
  }
}

export interface PlannerInput {
  parentCidr: string
  reservations: ReservedInput[]
  requirements: RequirementInput[]
}

/** 基线快照中的单个需求（按稳定 ID 参与对比） */
export interface BaselineEntry {
  id: string
  name: string
  /** 基线时的分配状态：已分配（固定/自动网段）或分配失败（未分配） */
  state: 'allocated' | 'unallocated'
  /** 已分配时的网段 CIDR */
  cidr?: string
  /** 已分配时的网络地址（数值） */
  start?: number
  /** 已分配时的广播地址（数值，含） */
  end?: number
  prefix?: number
  capacity?: number
  usable?: number
  hosts?: number
  kind?: 'fixed' | 'auto'
  /** 未分配时的失败原因 */
  reason?: string
}

/** 保存于当前浏览器会话的基线 */
export interface Baseline {
  createdAt: string
  parentCidr: string
  parentStart: number
  parentEnd: number
  parentSize: number
  entries: BaselineEntry[]
  /** 基线时点的全部占用区间（保留+固定+自动，已合并去重） */
  occupiedRanges: AddrRange[]
}

/** 需求级变化类型 */
export type ChangeType =
  | 'added' // 基线中不存在该需求
  | 'removed' // 基线中存在、当前已删除
  | 'unchanged' // 网段与容量均未变
  | 'resized' // CIDR 未变、容量变化（扩容/缩容）
  | 'migrated' // CIDR 改变（迁移），可能同时扩容/缩容
  | 'unallocated' // 基线已分配、当前分配失败（未分配）
  | 'recovered' // 基线分配失败、当前已分配（恢复分配）
  | 'still-unallocated' // 基线与当前均分配失败

export interface ChangeRow {
  type: ChangeType
  id: string
  name: string
  /** 容量变化方向（迁移时容量同时变化也会标记） */
  resize?: 'grow' | 'shrink'
  hosts?: number
  baseline?: BaselineEntry
  current?: BaselineEntry
}

export interface AddrRange {
  start: number
  end: number
}

/** 被勾选参与路由汇总的原需求网段（固定/自动） */
export interface SummaryMember {
  /** 需求稳定 ID（与 Segment.ownerId 一致） */
  id: string
  name: string
  kind: 'fixed' | 'auto'
  cidr: string
  prefix: number
  start: number
  end: number
}

/** 路由汇总后的单个 CIDR 块 */
export interface RouteSummaryBlock {
  cidr: string
  network: number
  prefix: number
  /** 地址数 = 2^(32-prefix) */
  size: number
  /** 该汇总块覆盖到的原需求网段（可能为多个被聚合的块） */
  members: SummaryMember[]
}

export interface DiffSummary {
  /** 新占用：基线空闲、当前被占用的地址区间 */
  occupied: AddrRange[]
  /** 释放：基线占用、当前变回空闲的地址区间 */
  released: AddrRange[]
  /** 仍占用：两个时点都被占用的地址区间（重叠已合并去重） */
  still: AddrRange[]
  occupiedCount: number
  releasedCount: number
  stillCount: number
  /** 净地址变化 = 新占用 - 释放（正数表示占用增加） */
  net: number
}

export interface BaselineComparison {
  baseline: Baseline
  rows: ChangeRow[]
  counts: Record<ChangeType, number>
  summary: DiffSummary
  /** 当前相对基线是否有任何差异 */
  hasChanges: boolean
}
