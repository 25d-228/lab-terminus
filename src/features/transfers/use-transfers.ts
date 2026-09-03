import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { TransferResponse } from "@/types"

const TRANSFER_POLL_MS = 1500

export function useTransfers(enabled = true) {
  const [jobs, setJobs] = useState<TransferResponse["jobs"]>([])
  const [open, setOpen] = useState(false)
  const refresh = async () => {
    const response = await api<TransferResponse>("/api/transfers")
    setJobs(response.jobs || [])
  }
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: number | undefined
    const tick = async () => {
      try {
        const response = await api<TransferResponse>("/api/transfers")
        if (!disposed) setJobs(response.jobs || [])
      } catch {
        // Preserve the last known queue while the backend is temporarily unreachable.
      }
      if (!disposed) timer = window.setTimeout(tick, TRANSFER_POLL_MS)
    }
    void tick()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [enabled])
  const activeCount = jobs.filter((job) => job.state === "active" || job.state === "queued").length
  return { jobs, activeCount, open, setOpen, refresh }
}
