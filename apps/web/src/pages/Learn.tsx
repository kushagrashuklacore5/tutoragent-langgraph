import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { S } from '../lib/studio.ts'
import { useSession } from '../session.tsx'
import { useLoad } from '../ui/kit.tsx'
import { UniversalChat } from '../chat/UniversalChat.tsx'
import Home from './Home.tsx'

interface Agenda { items: { kind: string; label: string; minutes: number; href?: string }[]; totalMinutes: number }
interface Rail { state: { nextSession: (Agenda & { courseId: string }) | null; appliedPlan: { courseId: string } | null } }
interface BookRow { id: string; title: string; sections: number; ready: number }

/** The study desk: the universal conversation is the centre; the rail shows where things stand. */
export default function Learn() {
  const s = useSession()
  // educators and admins keep their dashboard; students live in the conversation
  if (!s.tutorEnabled || !s.canStudy || !s.courses.some((c) => c.role === 'student')) return <Home />
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="mx-auto w-full max-w-3xl"><UniversalChat variant="home" /></div>
      <ContextRail />
    </div>
  )
}

function ContextRail() {
  const r = useLoad<Rail>('rail:agent', (sig) => api.get(`${TUTOR}/agent`, sig))
  const due = useLoad<unknown[]>('rail:due', (sig) => api.get(`${TUTOR}/cards/due`, sig))
  const books = useLoad<BookRow[]>('rail:books', (sig) => api.get(`${S}/books`, sig))
  const agenda = r.data?.state.nextSession
  return (
    <aside className="hidden content-start gap-4 xl:grid" aria-label="Where you are">
      <section className="uc-rail">
        <p className="uc-rail-h">Up next</p>
        {agenda?.items.length ? (
          <ol className="grid gap-2">{agenda.items.slice(0, 4).map((i) => <li key={i.label}>{i.href ? <Link to={i.href} className="uc-rail-item">{i.label}<span>{i.minutes} min</span></Link> : <span className="uc-rail-item">{i.label}<span>{i.minutes} min</span></span>}</li>)}</ol>
        ) : <p className="text-sm text-muted">Tell me your goal and I will prepare your first session.</p>}
      </section>
      <section className="uc-rail">
        <p className="uc-rail-h">Revision</p>
        <Link to="/revise" className="uc-rail-item">{due.data?.length ? `${due.data.length} card(s) due now` : 'Nothing due right now'}<span>→</span></Link>
      </section>
      <section className="uc-rail">
        <p className="uc-rail-h">Your books</p>
        {books.data?.length ? <ul className="grid gap-2">{books.data.slice(0, 4).map((b) => <li key={b.id}><Link to={`/studio/${b.id}`} className="uc-rail-item"><span className="truncate">{b.title}</span><span>{b.ready}/{b.sections}</span></Link></li>)}</ul> : <p className="text-sm text-muted">Books appear here when we start teaching a chapter.</p>}
      </section>
      <section className="uc-rail">
        <p className="uc-rail-h">Progress</p>
        <Link to="/growth" className="uc-rail-item">Levels, streak and before/after<span>→</span></Link>
      </section>
    </aside>
  )
}
