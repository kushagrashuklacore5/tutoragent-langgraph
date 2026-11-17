import { AppError } from '@platform/core'
import { enqueue, type JobContext, type JobHandler } from '@platform/jobs'
import type { Sql } from '@platform/tenancy-db'

export interface EventEnvelope<T = unknown> {
  topic: string
  payload: T
  publishedAt: string
}
export type EventHandler = (event: EventEnvelope, ctx: JobContext) => Promise<void>

interface Subscription {
  topic: string
  subscriber: string
  handler: EventHandler
  optional: boolean
}

const TOPIC = /^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.]*\.v\d+$/

/**
 * Transactional events on top of the job queue: `publish` enqueues one delivery job per current
 * subscriber in the publisher's transaction (outbox semantics). Deliveries retry like jobs; a
 * delivery whose subscriber has been removed dead-letters with `no_handler`, without affecting others.
 */
export class EventBus {
  private subs: Subscription[] = []
  private publishers = new Set<string>()

  declarePublisher(topic: string): void {
    if (!TOPIC.test(topic)) throw new AppError('event_topic_invalid', `Topic ${topic} must be <owner>.<event>.v<n>`)
    this.publishers.add(topic)
  }

  subscribe(topic: string, subscriber: string, handler: EventHandler, opts: { optional?: boolean } = {}): void {
    if (!TOPIC.test(topic)) throw new AppError('event_topic_invalid', `Topic ${topic} must be <owner>.<event>.v<n>`)
    this.subs.push({ topic, subscriber, handler, optional: opts.optional ?? false })
  }

  /** Subscriptions to topics nobody publishes. Optional ones are fine; required ones are a startup error. */
  unresolved(): { topic: string; subscriber: string; optional: boolean }[] {
    return this.subs.filter((s) => !s.topic.startsWith('platform.') && !this.publishers.has(s.topic)).map(({ topic, subscriber, optional }) => ({ topic, subscriber, optional }))
  }

  async publish(tx: Sql, topic: string, payload: unknown): Promise<number> {
    if (!this.publishers.has(topic) && !topic.startsWith('platform.')) throw new AppError('event_undeclared', `Topic ${topic} is not declared by any publisher`)
    const envelope: EventEnvelope = { topic, payload, publishedAt: new Date().toISOString() }
    let n = 0
    for (const s of this.subs.filter((x) => x.topic === topic)) {
      await enqueue(tx, `${s.subscriber}/event:${topic}`, envelope)
      n++
    }
    return n
  }

  /** Job handlers for the worker (one per subscription). */
  jobHandlers(): Map<string, JobHandler> {
    const m = new Map<string, JobHandler>()
    for (const s of this.subs) m.set(`${s.subscriber}/event:${s.topic}`, (ctx) => s.handler(ctx.job.payload as EventEnvelope, ctx))
    return m
  }

  subscriptionKeys(): string[] {
    return this.subs.map((s) => `${s.subscriber}<-${s.topic}`).sort()
  }
}
