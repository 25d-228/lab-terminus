import { CircleCheck, CircleDashed, CircleX } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { HostStatus } from "@/types"

type MachineState = "online" | "offline" | "connecting"

const statePresentation = {
  online: {
    Icon: CircleCheck,
    className:
      "border-green-500 bg-green-400 text-green-950 dark:border-green-300 dark:bg-green-400 dark:text-green-950",
  },
  offline: {
    Icon: CircleX,
    className:
      "border-red-500 bg-red-400 text-red-950 dark:border-red-300 dark:bg-red-400 dark:text-red-950",
  },
  connecting: {
    Icon: CircleDashed,
    className: "border-border bg-muted text-muted-foreground",
  },
} satisfies Record<
  MachineState,
  { Icon: typeof CircleCheck; className: string }
>

function machineState(status?: Pick<HostStatus, "online">): MachineState {
  if (status?.online === true) return "online"
  if (status?.online === false) return "offline"
  return "connecting"
}

interface MachineStateBadgeProps {
  status?: Pick<HostStatus, "online">
  compact?: boolean
  className?: string
}

export function MachineStateBadge({
  status,
  compact = false,
  className,
}: MachineStateBadgeProps) {
  const state = machineState(status)
  const { Icon, className: stateClassName } = statePresentation[state]

  return (
    <Badge
      variant="outline"
      aria-label={`Machine status: ${state}`}
      data-machine-state={state}
      className={cn(compact && "size-5 px-0", stateClassName, className)}
    >
      <Icon aria-hidden="true" />
      {compact ? <span className="sr-only">{state}</span> : state}
    </Badge>
  )
}
