import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MachineStateBadge } from "./machine-state"

describe("MachineStateBadge", () => {
  it("maps online, offline, and connecting to distinct semantic treatments", () => {
    render(
      <>
        <MachineStateBadge status={{ online: true }} />
        <MachineStateBadge status={{ online: false }} />
        <MachineStateBadge />
      </>,
    )

    expect(screen.getByLabelText("Machine status: online")).toHaveClass(
      "bg-green-400",
      "text-green-950",
      "dark:bg-green-400",
    )
    expect(screen.getByLabelText("Machine status: offline")).toHaveClass(
      "bg-red-400",
      "text-red-950",
      "dark:bg-red-400",
    )
    expect(screen.getByLabelText("Machine status: connecting")).toHaveClass(
      "bg-muted",
      "text-muted-foreground",
    )
  })
})
