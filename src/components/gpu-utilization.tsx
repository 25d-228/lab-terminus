import { cn } from "@/lib/utils"

const utilizationClasses = {
  blue: "text-blue-700 dark:text-blue-400",
  amber: "text-amber-700 dark:text-amber-400",
  orange: "text-orange-700 dark:text-orange-400",
  red: "text-red-700 dark:text-red-400",
}

export function gpuUtilizationClass(value: number) {
  if (value < 50) return utilizationClasses.blue
  if (value < 70) return utilizationClasses.amber
  if (value < 85) return utilizationClasses.orange
  return utilizationClasses.red
}

interface GpuUtilizationProps {
  value: number
  className?: string
}

export function GpuUtilization({ value, className }: GpuUtilizationProps) {
  return (
    <span
      className={cn(gpuUtilizationClass(value), className)}
      data-gpu-utilization={value}
    >
      {value}%
    </span>
  )
}
