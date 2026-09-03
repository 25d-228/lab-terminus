export type ServerKind = "ssh" | "wsl" | "nas"

export interface Server {
  id: string
  name: string
  kind: ServerKind
  host?: string
  port?: number
  user?: string
  gpuLabel?: string
  home?: string
  group?: string
  custom?: boolean
}

export interface Folder {
  key: string
  title: string
  custom?: boolean
}

export interface MemoryStatus { total: number; used: number }
export interface DiskStatus { m: string; size: number; used: number }
export interface GpuStatus {
  index: number
  name: string
  mu: number
  mt: number
  util: number
  temp: number
  pow: number
  plim: number
}
export interface GpuProcessStatus {
  pid: number
  gpu: number
  mem: number
  user: string
  etime: string
  cmd: string
}
export interface TopProcessStatus {
  pid: number
  user: string
  cpu_pct: number
  memory_pct: number
  resident_bytes: number
  elapsed: string
  command: string
}
export interface NetworkStatus {
  available: boolean
  rx_bytes: number
  tx_bytes: number
  uptime_seconds: number
}
export interface HostStatus {
  id: string
  online: boolean
  error?: string | null
  host: string
  up: string
  load: [number, number, number]
  ncpu: number
  mem: MemoryStatus
  disks: DiskStatus[]
  gpus: GpuStatus[]
  procs: GpuProcessStatus[]
  network: NetworkStatus
  top_procs: TopProcessStatus[]
}
export interface FleetResponse { servers: Array<HostStatus | null>; rev: number }
export interface OverviewPreference { group: string | null }

export interface FileEntry {
  name: string
  isdir: boolean
  islink?: boolean
  size: number
  mtime: number
}
export interface ListingResponse {
  path: string
  parent?: string
  entries: FileEntry[]
  error?: string
}
export type ProcessScope = "mine" | "others" | "root"

export type TransferState = "queued" | "active" | "done" | "error" | "canceled"
export interface TransferJob {
  id: string
  kind: "copy" | "upload" | "download"
  label: string
  state: TransferState
  done: number
  total: number
  speed: number
  error?: string | null
}
export interface TransferResponse { jobs: TransferJob[] }

export interface ServerDraft {
  name: string
  kind: ServerKind
  host: string
  port: string
  user: string
  gpuLabel: string
  group: string
}
