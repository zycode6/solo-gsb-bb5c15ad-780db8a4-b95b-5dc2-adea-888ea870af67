import type { PlanResult, Segment } from './types'

function segmentForExport(s: Segment) {
  const base = {
    类型:
      s.kind === 'reserved'
        ? '保留'
        : s.kind === 'fixed'
          ? '固定'
          : s.kind === 'auto'
            ? '自动'
            : '空闲',
    名称: s.name,
    网段: s.cidr,
    网络地址: s.network,
    广播地址: s.broadcast,
    可用范围: s.firstUsable === '—' ? '—' : `${s.firstUsable} ~ ${s.lastUsable}`,
    容量: s.capacity,
    可用主机数: s.usable,
  }
  if (s.kind === 'free') return base
  return {
    ...base,
    需求主机数: s.requestedHosts ?? null,
    浪费量: s.waste,
  }
}

export function buildExportJson(result: PlanResult, input: { parentCidr: string }): string {
  const payload = {
    导出时间: new Date().toISOString(),
    父CIDR: result.parentCidr || input.parentCidr,
    父网络地址: result.parentNetwork,
    父前缀长度: result.parentPrefix === -1 ? null : result.parentPrefix,
    父网段容量: result.parentSize,
    统计: {
      保留地址数: result.summary.reserved,
      固定网段地址数: result.summary.fixed,
      自动网段地址数: result.summary.auto,
      空闲地址数: result.summary.free,
      已分配可用地址: result.summary.allocatedUsable,
      需求主机总数: result.summary.requestedHosts,
      浪费地址数: result.summary.waste,
      地址利用率: `${result.summary.utilization.toFixed(2)}%`,
    },
    网段: result.segments.map(segmentForExport),
    失败需求: result.failures.map((f) => ({
      名称: f.name,
      需求主机数: f.hosts,
      原因: f.reason,
    })),
  }
  return JSON.stringify(payload, null, 2)
}

export function downloadJson(result: PlanResult, input: { parentCidr: string }) {
  const json = buildExportJson(result, input)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `vlsm-plan-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
