import type { HostStatus } from "@/types"

export function bytes(value: number | null | undefined): string {
  if (value == null || value < 0 || Number.isNaN(value)) return ""
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

export function age(epoch: number): string {
  if (!epoch) return ""
  const seconds = Math.floor(Date.now() / 1000 - epoch)
  if (seconds < 0) return ""
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months} mo ago` : `${Math.floor(months / 12)} y ago`
}

export function parentPath(path: string | undefined): string {
  if (!path || path === "/") return "/"
  const clean = path.replace(/\/+$/, "")
  const slash = clean.lastIndexOf("/")
  return slash > 0 ? clean.slice(0, slash) : "/"
}

export function joinPath(directory: string | undefined, name: string): string {
  return `${!directory || directory === "/" ? "" : directory}/${name}`
}

export function validName(value: string): string | null {
  const name = value.trim()
  if (!name) return "Name cannot be empty"
  if (name === "." || name === "..") return "Invalid name"
  if (name.includes("/")) return "Name can’t contain “/”"
  if (/\p{Cc}/u.test(name)) return "Invalid name"
  return null
}

export function gpuSummary(status?: HostStatus) {
  if (!status?.gpus.length) return null
  const idle = status.gpus.filter((gpu) => gpu.util < 10).length
  return {
    total: status.gpus.length,
    idle,
    average: Math.round(status.gpus.reduce((sum, gpu) => sum + gpu.util, 0) / status.gpus.length),
  }
}
