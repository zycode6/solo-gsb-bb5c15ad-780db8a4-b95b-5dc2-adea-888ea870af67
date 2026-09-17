import { useEffect, useMemo, useRef, useState } from 'react'
import { intToIp } from '../lib/ip'
import {
  blocksCoverExactly,
  selectableSegments,
  summarizeRoutes,
  totalSizeOf,
  type AllocatedSegment,
} from '../lib/summarize'
import type { PlanResult, SummaryMember } from '../lib/types'

const KIND_LABEL: Record<SummaryMember['kind'], string> = {
  fixed: '固定',
  auto: '自动',
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function toMember(seg: AllocatedSegment): SummaryMember {
  return {
    id: seg.ownerId,
    name: seg.name,
    kind: seg.kind,
    cidr: seg.cidr,
    prefix: seg.prefix,
    start: seg.start,
    end: seg.end,
  }
}

interface Props {
  result: PlanResult
}

export default function RouteSummaryPanel({ result }: Props) {
  // 当前成功分配的固定/自动网段（分配失败、已删除或保留区均不在其中）
  const selectable = useMemo(() => selectableSegments(result), [result])
  const selectableIds = useMemo(() => new Set(selectable.map((s) => s.ownerId)), [selectable])

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)

  // 规划变化后，移除已不存在或分配失败的选择
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (selectableIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [selectableIds])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const disabled = result.inputErrors.length > 0 || selectable.length === 0

  const selectedSegments = selectable.filter((s) => selectedIds.has(s.ownerId))
  const members = useMemo(() => selectedSegments.map(toMember), [selectedSegments])
  const blocks = useMemo(() => summarizeRoutes(members), [members])
  const selectedAddressCount = members.reduce((acc, m) => acc + (m.end - m.start + 1), 0)

  // 自检：汇总块必须与所选并集完全一致（无遗漏、无越界）
  const exact = members.length === 0 || blocksCoverExactly(blocks, members)

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(selectable.map((s) => s.ownerId)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  async function copyList() {
    if (blocks.length === 0) return
    const text = blocks.map((b) => b.cidr).join('\n')
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) {
      // 非安全上下文（如 http://局域网 IP）下回退到临时文本域
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(ta)
    }
    if (ok) {
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800)
    }
  }

  return (
    <div className={`panel summary-panel${disabled ? ' is-disabled' : ''}`}>
      <div className="header-row">
        <h2 style={{ marginBottom: 0 }}>
          ⑤ 路由汇总
          <span className="baseline-meta">
            勾选已成功分配的固定 / 自动网段，聚合为数量最少、覆盖精确的 CIDR
          </span>
        </h2>
        {!disabled && (
          <div className="btn-row" style={{ margin: 0 }}>
            <button onClick={selectAll} disabled={selectedIds.size === selectable.length}>
              全选
            </button>
            <button onClick={clearSelection} disabled={selectedIds.size === 0}>
              清空选择
            </button>
            <button className="primary" onClick={copyList} disabled={blocks.length === 0}>
              {copied ? '✓ 已复制' : '⧉ 复制 CIDR 列表'}
            </button>
          </div>
        )}
      </div>

      {disabled ? (
        <p className="subtitle" style={{ margin: '10px 0 0' }}>
          {result.inputErrors.length > 0
            ? '当前输入存在错误，路由汇总已暂停；修正输入后自动启用。'
            : '当前没有成功分配的固定或自动网段，暂无可汇总对象。'}
        </p>
      ) : (
        <>
          <div className="summary-pick-list">
            {selectable.map((seg) => (
              <label className="summary-pick" key={seg.ownerId}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(seg.ownerId)}
                  onChange={() => toggle(seg.ownerId)}
                />
                <span className={`badge ${seg.kind}`}>{KIND_LABEL[seg.kind]}</span>
                <span className="pick-name">{seg.name}</span>
                <span className="mono pick-cidr">{seg.cidr}</span>
                <span className="pick-size mono">{fmtNum(seg.capacity)} 地址</span>
              </label>
            ))}
          </div>

          {members.length === 0 ? (
            <p className="subtitle" style={{ margin: '12px 0 0' }}>
              勾选上方网段后，此处展示聚合结果：只有两个<strong>同前缀、连续且同属一个上级网段</strong>
              的块才会聚合，任何汇总项都不会包含未选需求、保留区或空闲地址。
            </p>
          ) : (
            <div className="summary-result">
              <div className="summary-line">
                已选 <strong>{members.length}</strong> 个网段，共{' '}
                <strong>{fmtNum(selectedAddressCount)}</strong> 个地址 → 聚合为{' '}
                <strong>{blocks.length}</strong> 条 CIDR
                {!exact && <span className="hint-warn">（汇总校验异常：覆盖与所选不一致）</span>}
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>汇总 CIDR</th>
                      <th style={{ textAlign: 'right' }}>地址数</th>
                      <th>覆盖的原需求</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocks.map((b, i) => (
                      <tr key={b.cidr}>
                        <td className="mono">{i + 1}</td>
                        <td className="mono">{b.cidr}</td>
                        <td style={{ textAlign: 'right' }} className="mono">
                          {fmtNum(b.size)}
                        </td>
                        <td>
                          <span className="covered-list">
                            {b.members.map((m) => (
                              <span className="covered-item" key={m.id}>
                                <span className={`badge ${m.kind}`}>{KIND_LABEL[m.kind]}</span>
                                {m.name}
                                <span className="mono covered-cidr">{m.cidr}</span>
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td />
                      <td className="mono">合计 {blocks.length} 条</td>
                      <td style={{ textAlign: 'right' }} className="mono">
                        {fmtNum(totalSizeOf(blocks))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="copy-preview-wrap">
                <div className="copy-preview-label">
                  纯 CIDR 列表（按网络地址升序，点击右上角按钮一键复制）
                  <span className="mono">
                    {intToIp(blocks[0].network)} … {intToIp(blocks[blocks.length - 1].network)}
                  </span>
                </div>
                <pre className="copy-preview mono">
                  {blocks.map((b) => b.cidr).join('\n')}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
