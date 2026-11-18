import { Link, useLocation } from 'react-router'
import { useSession } from '../session.tsx'
import { EmptyState, PageHeader } from '../ui/kit.tsx'

export default function NotFound() {
  const loc = useLocation()
  const s = useSession()
  const moduleRoute = s.modules?.ui.find((u) => loc.pathname.startsWith(u.path.split('/:')[0]!))
  return (
    <>
      <PageHeader title={moduleRoute ? moduleRoute.title : 'Page not found'} />
      <EmptyState title={moduleRoute ? 'Not available in this app yet' : 'We could not find that page'} action={<Link to="/" className="font-semibold text-accent underline">Go to Today</Link>}>
        {moduleRoute ? 'This module is enabled for your institution, but its screens are not part of this web app yet.' : 'The link may be old or mistyped.'}
      </EmptyState>
    </>
  )
}
