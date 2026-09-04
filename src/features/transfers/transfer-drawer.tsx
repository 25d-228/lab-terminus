import { ArrowDown, ArrowRight, ArrowUp, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import { bytes } from "@/lib/format"
import type { TransferJob } from "@/types"

interface TransferDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobs: TransferJob[]
  onRefresh: () => Promise<void>
}

export function TransferDrawer({
  open,
  onOpenChange,
  jobs,
  onRefresh,
}: TransferDrawerProps) {
  const request = async (path: string) => {
    try {
      await api(path, { method: "POST" })
      await onRefresh()
    } catch (error) {
      toast.add({
        title: "Transfer action failed",
        description: String(error),
        type: "error",
        timeout: 2600,
      })
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent className="w-[380px] max-w-[50vw]">
        <DrawerHeader className="flex-row items-start border-b pb-4">
          <div>
            <DrawerTitle>Transfers</DrawerTitle>
            <DrawerDescription>Current and recent file operations</DrawerDescription>
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void request("/api/transfers/clear")}
            >
              Clear done
            </Button>
            <DrawerClose render={<Button variant="ghost" size="icon-sm" />}>
              <X />
              <span className="sr-only">Close transfers</span>
            </DrawerClose>
          </div>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1 p-4">
          {jobs.length ? (
            <div className="space-y-3">
              {[...jobs].reverse().map((job) => (
                <TransferRow
                  key={job.id}
                  job={job}
                  onCancel={() => void request(`/api/transfers/${job.id}/cancel`)}
                />
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No transfers yet</EmptyTitle>
                <EmptyDescription>
                  Use “Send to…”, “Download”, or “Upload”.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  )
}

interface TransferRowProps {
  job: TransferJob
  onCancel: () => void
}

function TransferRow({ job, onCancel }: TransferRowProps) {
  const percent = job.total
    ? Math.min(100, Math.round((job.done / job.total) * 100))
    : job.state === "done"
      ? 100
      : 0
  const Icon =
    job.kind === "upload" ? ArrowUp : job.kind === "download" ? ArrowDown : ArrowRight
  const progressText =
    job.state === "active"
      ? `${job.speed > 0 ? `${bytes(job.speed)}/s · ` : ""}${percent}%`
      : job.error || `${percent}%`

  return (
    <Card size="sm">
      <CardContent className="gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-all text-sm">
            {job.label}
          </span>
          {job.state === "active" || job.state === "queued" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel transfer"
              onClick={onCancel}
            >
              <X />
            </Button>
          ) : (
            <Badge variant={job.state === "error" ? "destructive" : "secondary"}>
              {job.state}
            </Badge>
          )}
        </div>
        <Progress value={percent} />
        <div className="flex justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {job.total ? `${bytes(job.done)} / ${bytes(job.total)}` : bytes(job.done)}
          </span>
          <span>{progressText}</span>
        </div>
      </CardContent>
    </Card>
  )
}
