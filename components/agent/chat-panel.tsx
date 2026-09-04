"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowCounterClockwiseIcon, PaperPlaneTiltIcon, SparkleIcon, XIcon } from "@phosphor-icons/react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel, PanelFooter, PanelHeader } from "@/components/ui/panel"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { sendChatFrame, useAgentChat } from "@/lib/agent/chat-client"
import { isUndoableAgentCompletion, type ChatModelChoice, type ServerChatFrame } from "@/lib/agent/chat-protocol"
import { useSquig } from "@/lib/store"

interface Entry { id: string; role: "user" | "assistant" | "tool" | "error"; text: string }

const MODEL_LABELS: Record<ChatModelChoice, string> = {
  default: "GLM 5.3 Flash",
  kimi: "Kimi K2.6",
  strong: "Claude Sonnet 5",
}

function applyFrame(entries: Entry[], frame: ServerChatFrame): Entry[] {
  if (frame.type === "chat.delta") {
    const id = `assistant-${frame.turnId}`
    const existing = entries.findIndex((entry) => entry.id === id)
    if (existing < 0) return [...entries, { id, role: "assistant", text: frame.delta }]
    return entries.map((entry, index) => index === existing ? { ...entry, text: entry.text + frame.delta } : entry)
  }
  if (frame.type === "chat.tool") return [...entries, { id: `tool-${frame.turnId}-${entries.length}`, role: "tool", text: `${frame.name}: ${frame.summary}` }]
  if (frame.type === "review.pending" && !entries.some((entry) => entry.id === `assistant-${frame.turnId}`)) {
    return [...entries, { id: `assistant-${frame.turnId}`, role: "assistant", text: frame.message }]
  }
  if (frame.type === "chat.error") return [...entries, { id: `error-${frame.turnId}-${entries.length}`, role: "error", text: frame.message }]
  return entries
}

export function AgentChatPanel() {
  const chat = useAgentChat()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState<ChatModelChoice>("default")
  const [review, setReview] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<string | null>(null)
  const [undoTurn, setUndoTurn] = useState<string | null>(null)
  const seen = useRef(0)
  const resetEpoch = useRef(chat.resetEpoch)

  useEffect(() => {
    if (resetEpoch.current === chat.resetEpoch) return
    resetEpoch.current = chat.resetEpoch
    seen.current = 0
    setEntries([])
    setActiveTurn(null)
    setPendingTurn(null)
    setUndoTurn(null)
  }, [chat.resetEpoch])

  useEffect(() => {
    const unseen = chat.events.filter((event) => event.seq > seen.current)
    if (!unseen.length) return
    seen.current = unseen.at(-1)!.seq
    setEntries((current) => unseen.reduce((next, event) => applyFrame(next, event.frame), current))
    for (const { frame } of unseen) {
      if (frame.type === "review.pending") setPendingTurn(frame.turnId)
      if (frame.type === "chat.completed") {
        setActiveTurn(null)
        if (frame.status !== "pending") setPendingTurn(null)
        if (isUndoableAgentCompletion(frame)) setUndoTurn(frame.turnId)
        else if (frame.status === "completed" || frame.status === "accepted") setUndoTurn(null)
        if (frame.status === "undone") setUndoTurn(null)
      }
      if (frame.type === "chat.error") setActiveTurn(null)
    }
  }, [chat.events])

  const sendPrompt = () => {
    const message = prompt.trim()
    if (!message || activeTurn || pendingTurn) return
    const turnId = crypto.randomUUID()
    const state = useSquig.getState()
    const sent = sendChatFrame({
      type: "chat.start", turnId, clientRev: chat.rev, prompt: message, review, model,
      selection: state.selection, viewport: state.viewport, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    })
    if (!sent) return
    setEntries((current) => [...current, { id: `user-${turnId}`, role: "user", text: message }])
    setPrompt("")
    setActiveTurn(turnId)
  }

  if (!open) {
    return (
      <Button
        type="button"
        size="icon-lg"
        aria-label="Open Squig agent"
        title="Open Squig agent"
        onClick={() => setOpen(true)}
        className="absolute right-4 bottom-4 z-40 rounded-full shadow-panel"
      >
        <SparkleIcon weight="fill" />
      </Button>
    )
  }

  return (
    <Panel className="absolute right-4 bottom-4 z-40 h-[min(540px,calc(100dvh-2rem))] w-[360px] max-w-[calc(100vw-2rem)] max-sm:inset-x-3 max-sm:bottom-3 max-sm:h-[min(72dvh,560px)] max-sm:w-auto">
      <PanelHeader
        title="Squig agent"
        subtitle={chat.connected ? `Canvas revision ${chat.rev}` : "Waiting for local Worker…"}
        right={<Button type="button" size="icon-xs" variant="ghost" aria-label="Close agent" onClick={() => setOpen(false)}><XIcon /></Button>}
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Select value={model} onValueChange={(value) => setModel(value as ChatModelChoice)} disabled={!!activeTurn || !!pendingTurn}>
          <SelectTrigger size="sm" className="min-w-0 flex-1"><SelectValue>{(value) => MODEL_LABELS[value as ChatModelChoice]}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">GLM 5.3 Flash</SelectItem>
            <SelectItem value="kimi">Kimi K2.6</SelectItem>
            <SelectItem value="strong">Claude Sonnet 5</SelectItem>
          </SelectContent>
        </Select>
        <label htmlFor="agent-review" className="ml-auto text-label text-muted-foreground">Review</label>
        <Switch id="agent-review" size="sm" checked={review} onCheckedChange={setReview} disabled={!!activeTurn || !!pendingTurn} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-h-full flex-col gap-2 p-3">
          {!entries.length && (
            <p className="m-auto max-w-56 text-center text-row leading-relaxed text-muted-foreground">
              Ask the agent to add or revise something on this canvas.
            </p>
          )}
          {entries.map((entry) => (
            <Bubble key={entry.id} align={entry.role === "user" ? "end" : "start"} variant={entry.role === "user" ? "default" : entry.role === "error" ? "destructive" : entry.role === "tool" ? "outline" : "muted"}>
              <BubbleContent className={entry.role === "tool" ? "font-mono text-[11px] text-muted-foreground" : undefined}>{entry.text}</BubbleContent>
            </Bubble>
          ))}
          {activeTurn && <p className="px-1 text-label text-muted-foreground">thinking and drawing…</p>}
        </div>
      </ScrollArea>
      {pendingTurn && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          <p className="mr-auto text-label text-muted-foreground">Preview shown faintly</p>
          <Button type="button" size="sm" variant="outline" onClick={() => sendChatFrame({ type: "review.reject", turnId: pendingTurn, clientRev: chat.rev })}>Reject</Button>
          <Button type="button" size="sm" onClick={() => sendChatFrame({ type: "review.accept", turnId: pendingTurn, clientRev: chat.rev })}>Accept</Button>
        </div>
      )}
      <PanelFooter className="flex-col items-stretch">
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); sendPrompt() }}>
          <Input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Add a sign-up flow…"
            aria-label="Agent prompt"
            disabled={!chat.connected || !!activeTurn || !!pendingTurn}
            className="h-ctl-lg"
          />
          <Button type="submit" size="icon-lg" aria-label="Send prompt" disabled={!chat.connected || !prompt.trim() || !!activeTurn || !!pendingTurn}><PaperPlaneTiltIcon weight="fill" /></Button>
        </form>
        {undoTurn && !pendingTurn && (
          <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => sendChatFrame({ type: "agent.undo", turnId: undoTurn, clientRev: chat.rev })}>
            <ArrowCounterClockwiseIcon /> Undo agent turn
          </Button>
        )}
      </PanelFooter>
    </Panel>
  )
}
