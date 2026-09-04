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
  hideOnline?: boolean
  className?: string
}

export function MachineStateBadge({
  status,
  hideOnline = false,
  className,
}: MachineStateBadgeProps) {
  const state = machineState(status)
  const label = `Machine status: ${state}`

  if (state === "online" && hideOnline) {
    return (
      <span
        aria-label={label}
        className="sr-only"
        data-machine-state={state}
      >
        {state}
      </span>
    )
  }

  return (
    <Badge
      variant="outline"
      aria-label={label}
      data-machine-state={state}
      className={cn(statePresentation[state], className)}
    >
      {state}
    </Badge>
  )
}
