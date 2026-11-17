import { newId } from '@platform/core'
import type { SystemDatabase } from '@platform/tenancy-db/system'

export interface MailMessage {
  to: string
  subject: string
  text: string
}
/** Outbound email. The production provider is an open decision (O-5); it plugs in here. */
export interface MailTransport {
  send(msg: MailMessage): Promise<void>
}

/** Dev/test transport: stores messages in `platform.dev_mail_outbox` (refused in production by the API host). */
export function devOutboxTransport(system: SystemDatabase): MailTransport {
  return {
    async send(m) {
      await system.query('insert into platform.dev_mail_outbox (id, to_address, subject, body) values ($1, $2, $3, $4)', [newId(), m.to, m.subject, m.text])
    },
  }
}

/** In-memory transport for unit tests. */
export function memoryTransport(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = []
  return { sent, async send(m) { sent.push(m) } }
}
