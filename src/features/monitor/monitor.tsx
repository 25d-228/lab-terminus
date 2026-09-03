import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GripVertical } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api } from "@/lib/api"
import { bytes, percent } from "@/lib/format"
import type { HostStatus, ProcessScope, Server, TopProcessStatus } from "@/types"

const MONITOR_POLL_MS = 2000
const HISTORY_SAMPLES = 48
export const DEFAULT_MONITOR_ORDER = [
  "gpus",
  "network",
  "gpu-processes",
  "top-processes",
  "host",
  "utilization",
  "vram",
] as const

type SectionId = (typeof DEFAULT_MONITOR_ORDER)[number]
const LABELS: Record<SectionId, string> = {
  gpus: "GPUs",
  network: "Network",
  "gpu-processes": "GPU processes",
  "top-processes": "Top processes",
  host: "Host",
  utilization: "Utilization",
  vram: "VRAM",
}
const SCOPES: Record<ProcessScope, string> = {
  mine: "Mine",
  others: "Others",
  root: "Root",
}

interface ProcessState {
  scope: ProcessScope
  rows: TopProcessStatus[]
  loadedScope: ProcessScope | null
  loading: boolean
  error: string | null
  revision: number
  request: number
  applied: number
  inFlight: number | null
}

interface NetState {
  sample: { rx: number; tx: number; uptime: number } | null
  rate: { rx: number; tx: number } | null
  rx: number[]
  tx: number[]
}

interface DragState {
  id: SectionId
  over?: SectionId
  after?: boolean
  original: SectionId[]
}

interface MonitorSection {
  body: React.ReactNode
  detail?: React.ReactNode
}

interface MonitorProps {
  server: Server | null
  fleetStatus?: HostStatus
  visible: boolean
  onStatus: (status: HostStatus) => void
}

export function Monitor({ server, fleetStatus, visible, onStatus }: MonitorProps) {
  const [status, setStatus] = useState<HostStatus | undefined>(fleetStatus)
  const [processes, setProcesses] = useState<Record<string, ProcessState>>({})
  const [order, setOrder] = useState<SectionId[]>([...DEFAULT_MONITOR_ORDER])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<DragState | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const dragRef = useRef<DragState | null>(null)
  const histories = useRef<Record<string, Array<{ u: number; m: number }>>>({})
  const networks = useRef<Record<string, NetState>>({})
  const pending = useRef<HostStatus | undefined>(undefined)
  const activeServerId = useRef(server?.id)
  const processRef = useRef(processes)
  const statusRef = useRef(status)

  dragRef.current = drag
  activeServerId.current = server?.id
  processRef.current = processes
  statusRef.current = status

  const applyMonitorSample = useCallback(
    (next: HostStatus) => {
      if (dragRef.current) {
        pending.current = next
        return
      }
      if (next.id === activeServerId.current) setStatus(next)
      onStatus(next)
      for (const gpu of next.gpus) {
        const samples = (histories.current[`${next.id}:${gpu.index}`] ||= [])
        samples.push({ u: gpu.util, m: percent(gpu.mu, gpu.mt) })
        if (samples.length > HISTORY_SAMPLES) samples.shift()
      }
      updateNetwork(networks.current, next)
      setProcesses((current) => {
        const state = current[next.id]
        if (!state || state.scope !== "mine" || state.loading) return current
        return {
          ...current,
          [next.id]: {
            ...state,
            rows: next.top_procs || [],
            loadedScope: "mine",
            error: null,
          },
        }
      })
    },
    [onStatus],
  )

  useEffect(() => {
    if (!fleetStatus || fleetStatus.id !== server?.id) return
    setStatus(fleetStatus)
    if (visible && !networks.current[fleetStatus.id]?.sample) {
      updateNetwork(networks.current, fleetStatus)
    }
  }, [fleetStatus, server?.id, visible])

  useEffect(() => {
    setStatus(fleetStatus)
  }, [server?.id])

  const processState = useCallback(
    (id: string): ProcessState =>
      processRef.current[id] || {
        scope: "mine",
        rows: statusRef.current?.top_procs || [],
        loadedScope: "mine",
        loading: false,
        error: null,
        revision: 0,
        request: 0,
        applied: 0,
        inFlight: null,
      },
    [],
  )

  const requestStatus = useCallback(
    async (host: Server, showLoading: boolean) => {
      const before = processState(host.id)
      if (!showLoading && before.inFlight === before.revision) return
      const request = before.request + 1
      const scope = before.scope
      const revision = before.revision
      const requesting: ProcessState = {
        ...before,
        request,
        inFlight: revision,
        ...(showLoading
          ? { rows: [], loadedScope: null, loading: true, error: null }
          : {}),
      }
      processRef.current = { ...processRef.current, [host.id]: requesting }
      setProcesses(processRef.current)

      try {
        const next = await api<HostStatus>(
          `/api/${host.id}/status?process_scope=${scope}`,
        )
        const current = processRef.current[host.id]
        if (
          !current ||
          current.revision !== revision ||
          current.scope !== scope ||
          request <= current.applied
        ) {
          return
        }
        const applied: ProcessState = {
          ...current,
          rows: next.top_procs || [],
          loadedScope: scope,
          loading: false,
          error: null,
          applied: request,
          inFlight: null,
        }
        processRef.current = { ...processRef.current, [host.id]: applied }
        setProcesses(processRef.current)
        applyMonitorSample(next)
      } catch (error) {
        const current = processRef.current[host.id]
        if (
          !current ||
          current.revision !== revision ||
          current.scope !== scope ||
          request <= current.applied
        ) {
          return
        }
        const failed: ProcessState = {
          ...current,
          rows: [],
          loadedScope: null,
          loading: false,
          error: String(error),
          applied: request,
          inFlight: null,
        }
        processRef.current = { ...processRef.current, [host.id]: failed }
        setProcesses(processRef.current)
        networks.current[host.id] = emptyNetwork()
      }
    },
    [applyMonitorSample, processState],
  )

  useEffect(() => {
    if (!visible || !server || server.kind === "nas") return
    let disposed = false
    let timer: number | undefined
    const tick = async () => {
      await requestStatus(server, false)
      if (!disposed) timer = window.setTimeout(tick, MONITOR_POLL_MS)
    }
    timer = window.setTimeout(tick, MONITOR_POLL_MS)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [requestStatus, server, visible])

  const changeScope = (scope: ProcessScope) => {
    if (!server || server.kind === "nas") return
    const current = processState(server.id)
    if (current.scope === scope) return
    const next: ProcessState = {
      ...current,
      scope,
      revision: current.revision + 1,
      rows: [],
      loadedScope: null,
      loading: true,
      error: null,
      inFlight: null,
    }
    processRef.current = { ...processRef.current, [server.id]: next }
    setProcesses(processRef.current)
    queueMicrotask(() => void requestStatus(server, true))
  }

  const move = (
    id: SectionId,
    target: SectionId,
    after: boolean,
    visibleIds?: SectionId[],
  ) => {
    if (id === target) return
    setOrder((current) => {
      const next = current.filter((section) => section !== id)
      const index = next.indexOf(target)
      next.splice(index + (after ? 1 : 0), 0, id)
      const announced = visibleIds
        ? next.filter((section) => visibleIds.includes(section))
        : next
      setAnnouncement(
        `${LABELS[id]} moved to position ${announced.indexOf(id) + 1} of ${announced.length}.`,
      )
      return next
    })
  }

  const applyPending = () => {
    if (!pending.current) return
    const next = pending.current
    pending.current = undefined
    queueMicrotask(() => applyMonitorSample(next))
  }

  const clearDragDestination = () => {
    const current = dragRef.current
    if (!current || current.over === undefined) return
    const next = { id: current.id, original: current.original }
    dragRef.current = next
    setDrag(next)
  }

  const finishDrag = () => {
    if (dragRef.current?.over) {
      move(
        dragRef.current.id,
        dragRef.current.over,
        !!dragRef.current.after,
        order.filter((id) => sections[id]),
      )
    }
    dragRef.current = null
    setDrag(null)
    applyPending()
  }

  useEffect(() => {
    if (!drag) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOrder(drag.original)
      dragRef.current = null
      setDrag(null)
      applyPending()
    }
    document.addEventListener("keydown", cancel)
    return () => document.removeEventListener("keydown", cancel)
  }, [drag])

  const sections = useMemo(
    () =>
      status && server
        ? buildSections(
            status,
            processState(server.id),
            networks.current[server.id] || emptyNetwork(),
            histories.current,
            expanded,
            setExpanded,
            changeScope,
          )
        : {},
    [expanded, processState, server, status],
  )

  if (!visible) return null
  if (!server || !status) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Connecting…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!status.online) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{server.name} is offline.</EmptyTitle>
          <EmptyDescription>{status.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (server.kind === "nas") {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <Section heading="Host · storage" detail="volume">
          {hostVitals(status)}
        </Section>
      </div>
    )
  }

  const visibleOrder = order.filter((id) => sections[id])
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-5"
      onDragOver={(event) => {
        const target = event.target as Element
        if (!target.closest("[data-monitor-section]")) clearDragDestination()
      }}
      onDrop={(event) => {
        if (!dragRef.current) return
        event.preventDefault()
        finishDrag()
      }}
    >
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div className="space-y-5">
        {visibleOrder.map((id, index) => (
          <section
            key={id}
            data-monitor-section={id}
            className={`${drag?.id === id ? "opacity-50" : ""} ${
              drag?.over === id
                ? drag.after
                  ? "border-b-2 border-ring"
                  : "border-t-2 border-ring"
                : ""
            }`}
            onDragOver={(event) => {
              if (!drag) return
              event.preventDefault()
              event.stopPropagation()
              if (drag.id === id) {
                clearDragDestination()
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              const next = {
                ...drag,
                over: id,
                after: event.clientY >= rect.top + rect.height / 2,
              }
              dragRef.current = next
              setDrag(next)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              finishDrag()
            }}
          >
            <div className="mb-2 flex items-center gap-2">
              <button
                draggable
                aria-label={`${LABELS[id]}, position ${index + 1} of ${visibleOrder.length}. Alt plus Up or Down Arrow moves this section.`}
                title="Drag to reorder · Alt+Arrow to move"
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move"
                  event.dataTransfer.setData(
                    "application/x-lab-terminus-monitor-section",
                    id,
                  )
                  const next = { id, original: order }
                  dragRef.current = next
                  setDrag(next)
                }}
                onDragEnd={() => {
                  dragRef.current = null
                  setDrag(null)
                  applyPending()
                }}
                onKeyDown={(event) => {
                  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return
                  event.preventDefault()
                  const direction = event.key === "ArrowUp" ? -1 : 1
                  const target = visibleOrder[index + direction]
                  if (target) move(id, target, direction > 0, visibleOrder)
                }}
              >
                <GripVertical className="size-4 text-muted-foreground" />
              </button>
              <h2 className="text-sm font-semibold">{LABELS[id]}</h2>
              <div className="h-px flex-1 bg-border" />
              {sections[id]?.detail && (
                <span className="text-xs text-muted-foreground">{sections[id].detail}</span>
              )}
            </div>
            {sections[id]?.body}
          </section>
        ))}
      </div>
    </div>
  )
}

function emptyNetwork(): NetState {
  return { sample: null, rate: null, rx: [], tx: [] }
}

export function updateNetwork(states: Record<string, NetState>, status: HostStatus) {
  const network = status.network
  if (
    !network?.available ||
    !Number.isSafeInteger(network.rx_bytes) ||
    !Number.isSafeInteger(network.tx_bytes) ||
    !Number.isSafeInteger(network.uptime_seconds) ||
    network.rx_bytes < 0 ||
    network.tx_bytes < 0 ||
    network.uptime_seconds < 0
  ) {
    states[status.id] = emptyNetwork()
    return
  }
  const current = {
    rx: network.rx_bytes,
    tx: network.tx_bytes,
    uptime: network.uptime_seconds,
  }
  const state = states[status.id]
  if (!state?.sample) {
    states[status.id] = { ...emptyNetwork(), sample: current }
    return
  }
  const elapsed = current.uptime - state.sample.uptime
  if (elapsed <= 0 || current.rx < state.sample.rx || current.tx < state.sample.tx) {
    states[status.id] = { ...emptyNetwork(), sample: current }
    return
  }
  const rate = {
    rx: (current.rx - state.sample.rx) / elapsed,
    tx: (current.tx - state.sample.tx) / elapsed,
  }
  if (!Number.isFinite(rate.rx) || !Number.isFinite(rate.tx) || rate.rx < 0 || rate.tx < 0) {
    states[status.id] = { ...emptyNetwork(), sample: current }
    return
  }
  state.sample = current
  state.rate = rate
  state.rx.push(rate.rx)
  state.tx.push(rate.tx)
  if (state.rx.length > HISTORY_SAMPLES) state.rx.shift()
  if (state.tx.length > HISTORY_SAMPLES) state.tx.shift()
}

function buildSections(
  status: HostStatus,
  process: ProcessState,
  network: NetState,
  histories: Record<string, Array<{ u: number; m: number }>>,
  expanded: Record<string, boolean>,
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  changeScope: (scope: ProcessScope) => void,
): Partial<Record<SectionId, MonitorSection>> {
  const freeGpus = status.gpus.filter(
    (gpu) => gpu.util < 10 && percent(gpu.mu, gpu.mt) < 10,
  ).length
  const gpuCards = status.gpus.length ? (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
      {status.gpus.map((gpu) => {
        const memory = percent(gpu.mu, gpu.mt)
        const free = gpu.util < 10 && memory < 10
        return (
          <Card key={gpu.index}>
            <CardHeader className="flex-row items-start">
              <div>
                <CardTitle>GPU {gpu.index}</CardTitle>
                <p className="text-xs text-muted-foreground">{gpu.name}</p>
              </div>
              <Badge className="ml-auto" variant={free ? "default" : "secondary"}>
                {free ? "FREE" : `${gpu.util}% util`}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <strong className="text-2xl">
                  {((gpu.mt - gpu.mu) / 1024).toFixed(1)}
                </strong>{" "}
                <span className="text-xs text-muted-foreground">GB free</span>
              </div>
              <Progress value={memory} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{(gpu.mu / 1024).toFixed(1)} / {(gpu.mt / 1024).toFixed(0)} GB</span>
                <span>{Math.round(gpu.pow)}/{gpu.plim} W · {gpu.temp}°C</span>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  ) : (
    <div className="rounded-lg border p-4 text-sm text-muted-foreground">
      No GPU on this host — CPU server · {status.ncpu || "?"} cores · load{" "}
      {status.load?.[0] ?? "?"}
    </div>
  )

  const networkSamples = Math.max(network.rx.length, network.tx.length)
  const networkDetail = !status.network?.available
    ? "unavailable"
    : networkSamples < 2
      ? "collecting"
      : `${networkSamples} samples`
  const networkSection = (
    <div className="grid grid-cols-2 gap-3">
      <MetricCard
        label="Receive"
        value={!status.network?.available ? "Unavailable" : network.rate ? `${bytes(network.rate.rx)}/s` : "Collecting…"}
        points={network.rx}
      />
      <MetricCard
        label="Transmit"
        value={!status.network?.available ? "Unavailable" : network.rate ? `${bytes(network.rate.tx)}/s` : "Collecting…"}
        points={network.tx}
      />
    </div>
  )

  const gpuRows = [...status.procs]
    .sort((left, right) => (right.mem || 0) - (left.mem || 0))
    .map((item) => ({
      key: `gpu:${item.pid}`,
      cells: [item.user, item.pid, item.gpu, `${(item.mem / 1024).toFixed(1)} GB`, item.etime, item.cmd],
      command: item.cmd,
    }))
  const gpuProcesses = (
    <ProcessTable
      columns={["USER", "PID", "GPU", "VRAM", "TIME", "COMMAND"]}
      rows={gpuRows}
      empty={`No GPU processes${status.gpus.length ? " — GPUs idle, or other users’ jobs not visible" : ""}.`}
      expanded={expanded}
      setExpanded={setExpanded}
    />
  )

  const limit = process.scope === "mine" ? 20 : 50
  const rows = process.loadedScope === process.scope ? process.rows.slice(0, limit) : []
  const processDetail = process.loading
    ? "Loading"
    : process.error
      ? "Error"
      : `${SCOPES[process.scope]} · ${rows.length}`
  const topProcesses = (
    <div className="space-y-2">
      <ToggleGroup
        value={[process.scope]}
        onValueChange={(values) => {
          const scope = values[0] as ProcessScope | undefined
          if (scope) changeScope(scope)
        }}
        variant="outline"
        spacing={0}
        aria-label="Process owner scope"
      >
        {(Object.keys(SCOPES) as ProcessScope[]).map((scope) => (
          <ToggleGroupItem key={scope} value={scope} aria-label={`Show ${SCOPES[scope]} processes`}>
            {SCOPES[scope]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {process.loading ? (
        <div role="status" className="rounded-lg border p-5 text-sm text-muted-foreground">
          Loading {SCOPES[process.scope]} processes…
        </div>
      ) : process.error ? (
        <div role="alert" className="rounded-lg border p-5 text-sm text-destructive">
          Could not load {SCOPES[process.scope]} processes. {process.error}
        </div>
      ) : (
        <ProcessTable
          columns={["USER", "PID", "CPU", "MEM", "RSS", "TIME", "COMMAND"]}
          rows={rows.map((item) => ({
            key: `top:${process.scope}:${item.pid}`,
            cells: [
              item.user,
              item.pid,
              `${item.cpu_pct.toFixed(1)}%`,
              `${item.memory_pct.toFixed(1)}%`,
              bytes(item.resident_bytes),
              item.elapsed,
              item.command,
            ],
            command: item.command,
          }))}
          empty={
            process.scope === "mine"
              ? "No processes owned by your remote account."
              : process.scope === "others"
                ? "No processes owned by other non-root accounts."
                : "No root-owned processes."
          }
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
    </div>
  )

  const utilSeries = status.gpus.map((gpu) => ({
    label: `GPU${gpu.index}`,
    values: (histories[`${status.id}:${gpu.index}`] || [{ u: gpu.util, m: percent(gpu.mu, gpu.mt) }]).map((sample) => sample.u),
  }))
  const memorySeries = status.gpus.map((gpu) => ({
    label: `GPU${gpu.index}`,
    values: (histories[`${status.id}:${gpu.index}`] || [{ u: gpu.util, m: percent(gpu.mu, gpu.mt) }]).map((sample) => sample.m),
  }))
  const historySpan = Math.max(
    1,
    ...status.gpus.map((gpu) => histories[`${status.id}:${gpu.index}`]?.length || 0),
  )
  const minutes = Math.round(((historySpan * MONITOR_POLL_MS) / 60_000) * 10) / 10

  return {
    gpus: {
      body: gpuCards,
      detail: status.gpus.length ? `${freeGpus}/${status.gpus.length} free` : undefined,
    },
    network: { body: networkSection, detail: networkDetail },
    "gpu-processes": { body: gpuProcesses, detail: String(gpuRows.length) },
    "top-processes": { body: topProcesses, detail: processDetail },
    host: { body: hostVitals(status), detail: status.up ? `up ${status.up}` : undefined },
    ...(status.gpus.length
      ? {
          utilization: {
            body: <LineChart series={utilSeries} />,
            detail: `% · last ${historySpan < 2 ? "now" : `${minutes} min`}`,
          },
          vram: {
            body: <LineChart series={memorySeries} danger={90} />,
            detail: "% of total · 90% danger",
          },
        }
      : {}),
  }
}

function Section({ heading, detail, children }: { heading: string; detail?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <div className="h-px flex-1 bg-border" />
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
      {children}
    </section>
  )
}

function MetricCard({ label, value, points }: { label: string; value: string; points: number[] }) {
  const max = Math.max(1, ...points)
  const line = points.length
    ? points.map((point, index) => `${points.length < 2 ? index * 100 : (index / (points.length - 1)) * 100},${28 - (point / max) * 28}`).join(" ")
    : ""
  return (
    <Card>
      <CardHeader className="flex-row">
        <CardTitle>{label}</CardTitle>
        <strong className="ml-auto text-sm">{value}</strong>
      </CardHeader>
      <CardContent>
        {line ? (
          <svg className="h-12 w-full" viewBox="0 0 100 28" preserveAspectRatio="none">
            <polyline points={line} fill="none" stroke="var(--chart-2)" strokeWidth="1.5" />
          </svg>
        ) : (
          <span className="text-xs text-muted-foreground">Collecting trend…</span>
        )}
      </CardContent>
    </Card>
  )
}

interface ProcessRow {
  key: string
  cells: React.ReactNode[]
  command: string
}

function ProcessTable({
  columns,
  rows,
  empty,
  expanded,
  setExpanded,
}: {
  columns: string[]
  rows: ProcessRow[]
  empty: string
  expanded: Record<string, boolean>
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-flow-col auto-cols-fr bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {columns.map((column) => <span key={column}>{column}</span>)}
      </div>
      {rows.length ? (
        rows.map((row) => (
          <div key={row.key}>
            <button
              className="grid w-full grid-flow-col auto-cols-fr px-3 py-2 text-left text-xs hover:bg-muted/50"
              onClick={() => setExpanded((state) => ({ ...state, [row.key]: !state[row.key] }))}
            >
              {row.cells.map((cell, index) => (
                <span key={index} className="truncate" title={index === row.cells.length - 1 ? row.command : undefined}>
                  {cell}
                </span>
              ))}
            </button>
            {expanded[row.key] && (
              <div className="border-t bg-muted/30 p-2 font-mono text-xs break-all">{row.command}</div>
            )}
          </div>
        ))
      ) : (
        <div className="p-5 text-sm text-muted-foreground">{empty}</div>
      )}
    </div>
  )
}

function hostVitals(status: HostStatus) {
  const values: Array<{ label: string; value: string; percent: number }> = []
  if (status.ncpu) {
    values.push({
      label: "CPU load",
      value: `${status.load[0]} / ${status.ncpu}`,
      percent: Math.min(100, (status.load[0] / status.ncpu) * 100),
    })
  }
  if (status.mem?.total) {
    values.push({
      label: "System RAM",
      value: `${bytes(status.mem.used)} / ${bytes(status.mem.total)}`,
      percent: percent(status.mem.used, status.mem.total),
    })
  }
  for (const disk of status.disks) {
    values.push({
      label: disk.m,
      value: `${bytes(disk.used)} / ${bytes(disk.size)}`,
      percent: percent(disk.used, disk.size),
    })
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      {values.length ? (
        values.map((value) => (
          <Card key={value.label}>
            <CardHeader className="flex-row">
              <CardTitle>{value.label}</CardTitle>
              <span className="ml-auto text-xs">{value.value}</span>
            </CardHeader>
            <CardContent>
              <Progress value={value.percent} />
              <p className="mt-2 text-xs text-muted-foreground">{Math.round(value.percent)}% used</p>
            </CardContent>
          </Card>
        ))
      ) : (
        <div className="rounded-lg border p-5 text-sm text-muted-foreground">No vitals reported.</div>
      )}
    </div>
  )
}

function LineChart({ series, danger }: { series: Array<{ label: string; values: number[] }>; danger?: number }) {
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | null>(null)
  const count = Math.max(1, ...series.map((item) => item.values.length))
  return (
    <div
      className="relative rounded-lg border p-3"
      onMouseLeave={() => setTip(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
        setTip({ index: Math.round(x * (count - 1)), x: event.clientX - rect.left, y: 8 })
      }}
    >
      <svg className="h-36 w-full" viewBox="0 0 100 40" preserveAspectRatio="none">
        {[0, 50, 100].map((value) => (
          <line key={value} x1="0" x2="100" y1={40 - value * 0.4} y2={40 - value * 0.4} stroke="var(--border)" strokeWidth=".3" />
        ))}
        {danger != null && (
          <line x1="0" x2="100" y1={40 - danger * 0.4} y2={40 - danger * 0.4} stroke="var(--destructive)" strokeDasharray="2 2" strokeWidth=".4" />
        )}
        {series.map((item, seriesIndex) => (
          <polyline
            key={item.label}
            fill="none"
            stroke={`var(--chart-${(seriesIndex % 5) + 1})`}
            strokeWidth=".8"
            points={item.values
              .map(
                (value, index) =>
                  `${item.values.length < 2 ? index * 100 : (index / (item.values.length - 1)) * 100},${40 - value * 0.4}`,
              )
              .join(" ")}
          />
        ))}
      </svg>
      {tip && (
        <div className="pointer-events-none absolute z-10 rounded-md border bg-popover p-2 text-xs shadow-md" style={{ left: tip.x + 8, top: tip.y }}>
          {tip.index === count - 1 ? "now" : `~${((count - 1 - tip.index) * MONITOR_POLL_MS) / 1000}s ago`}
          {series.map((item) => (
            <div key={item.label}>
              {item.label}{" "}
              <b>{Math.round(item.values[Math.min(tip.index, item.values.length - 1)] || 0)}%</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
