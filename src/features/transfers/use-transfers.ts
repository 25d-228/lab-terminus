import { useCallback, useEffect, useState } from "react"

import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import type { TransferResponse } from "@/types"

const TRANSFER_POLL_MS = 1500

export interface UploadBatch {
  serverId: string
  destinationPath: string
  files: File[]
}

export interface UploadBatchResult {
  failed: number
  total: number
}

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
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [enabled])
  const activeCount = jobs.filter(
    (job) => job.state === "active" || job.state === "queued",
  ).length
  const uploadBatch = useCallback(async (batch: UploadBatch) => {
    const accepted = {
      ...batch,
      files: [...batch.files],
    }
    setOpen(true)
    let failed = 0

    for (const file of accepted.files) {
      try {
        const destination = encodeURIComponent(accepted.destinationPath)
        const name = encodeURIComponent(file.name)
        const response = await fetch(
          `/api/${accepted.serverId}/upload?path=${destination}&name=${name}`,
          { method: "POST", body: file },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        failed += 1
        toast.add({
          title: `Upload failed: ${file.name}`,
          description: String(error),
          type: "error",
          timeout: 2600,
        })
      }
    }

    if (!failed) {
      toast.add({ title: "Upload complete", type: "success", timeout: 2600 })
    } else if (failed < accepted.files.length) {
      toast.add({
        title: `${accepted.files.length - failed} of ${accepted.files.length} uploads completed`,
        type: "warning",
        timeout: 2600,
      })
    }

    return { failed, total: accepted.files.length }
  }, [])

  return { jobs, activeCount, open, setOpen, refresh, uploadBatch }
}
