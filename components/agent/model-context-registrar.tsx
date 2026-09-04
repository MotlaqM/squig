"use client"

import { useEffect } from "react"
import { registerSquigTools, type SquigToolRegistration } from "@/lib/agent/tools"

let consumers = 0
let active: SquigToolRegistration | null = null
let starting: Promise<SquigToolRegistration> | null = null

function acquire(): Promise<SquigToolRegistration> {
  consumers++
  if (!starting) {
    starting = registerSquigTools()
      .then((registration) => {
        active = registration
        if (consumers === 0) {
          registration.dispose()
          active = null
          starting = null
        }
        return registration
      })
      .catch((error) => {
        starting = null
        throw error
      })
  }
  return starting
}

function release() {
  consumers = Math.max(0, consumers - 1)
  if (consumers === 0 && active) {
    active.dispose()
    active = null
    starting = null
  }
}

/** Installs the page-owned WebMCP catalogue without adding visible UI. */
export function ModelContextRegistrar() {
  useEffect(() => {
    void acquire().catch((error) => console.error("Could not register Squig WebMCP tools", error))
    return release
  }, [])

  return null
}
