import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { GpuUtilization } from "./gpu-utilization"

afterEach(cleanup)

describe("GpuUtilization", () => {
  it.each([
    [49, "text-blue-700", "dark:text-blue-400"],
    [50, "text-amber-700", "dark:text-amber-400"],
    [69, "text-amber-700", "dark:text-amber-400"],
    [70, "text-orange-700", "dark:text-orange-400"],
    [84, "text-orange-700", "dark:text-orange-400"],
    [85, "text-red-700", "dark:text-red-400"],
  ])("maps %i%% to the shared utilization scale", (value, lightClass, darkClass) => {
    render(<GpuUtilization value={value} />)

    expect(screen.getByText(`${value}%`)).toHaveClass(lightClass, darkClass)
  })
})
