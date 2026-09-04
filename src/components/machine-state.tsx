import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { HostStatus } from "@/types"

type MachineState = "online" | "offline" | "connecting"

const statePresentation = {
  online: "text-green-700 dark:text-green-400",
  offline: "text-red-700 dark:text-red-400",
  connecting: "text-muted-foreground",
} satisfies Record<MachineState, string>

function machineState(status?: Pick<HostStatus, "online">): MachineState {
  if (status?.online === true) return "online"
  if (status?.online === false) return "offline"
  return "connecting"
}

interface MachineStateBadgeProps {
  status?: Pick<HostStatus, "online">
  className?: string
}

export function MachineStateBadge({ status, className }: MachineStateBadgeProps) {
  const state = machineState(status)

  return (
    <Badge
      variant="outline"
      aria-label={`Machine status: ${state}`}
      data-machine-state={state}
      className={cn(statePresentation[state], className)}
    >
      {state}
    </Badge>
  )
}
