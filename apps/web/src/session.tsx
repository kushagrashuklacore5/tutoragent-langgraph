import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, TUTOR, api, setUnauthorizedHandler } from './lib/api.ts'
import type { Course, Me, PlatformModules } from './lib/tutor.ts'

export interface SessionValue {
  status: 'loading' | 'signed_out' | 'signed_in' | 'error'
  me: Me | null
  modules: PlatformModules | null
  /** courses the person is enrolled in (empty when the tutor module is off) */
  courses: Course[]
  coursesError: unknown
  tutorEnabled: boolean
  isEducator: boolean
  canStudy: boolean
  refresh: () => Promise<void>
  refreshCourses: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<SessionValue | null>(null)
export const TUTOR_MODULE = 'education.tutor'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue['status']>('loading')
  const [me, setMe] = useState<Me | null>(null)
  const [modules, setModules] = useState<PlatformModules | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [coursesError, setCoursesError] = useState<unknown>(null)

  const refreshCourses = useCallback(async () => {
    try {
      setCourses(await api.get<Course[]>(`${TUTOR}/courses`))
      setCoursesError(null)
    } catch (e) {
      setCoursesError(e)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('/api/me')
      const mods = await api.get<PlatformModules>('/api/platform/modules')
      setMe(m)
      setModules(mods)
      if (mods.modules.includes(TUTOR_MODULE)) await refreshCourses()
      setStatus('signed_in')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setMe(null); setStatus('signed_out') }
      else setStatus('error')
    }
  }, [refreshCourses])

  useEffect(() => {
    setUnauthorizedHandler(() => { setMe(null); setStatus('signed_out') })
    void refresh()
    return () => setUnauthorizedHandler(null)
  }, [refresh])

  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/logout') } catch { /* already gone */ }
    setMe(null)
    setModules(null)
    setCourses([])
    setStatus('signed_out')
  }, [])

  const value = useMemo<SessionValue>(() => {
    const roles = me?.roles ?? []
    return {
      status, me, modules, courses, coursesError,
      tutorEnabled: !!modules?.modules.includes(TUTOR_MODULE),
      isEducator: roles.includes('educator') || roles.includes('tenant_admin'),
      canStudy: roles.includes('student') || roles.includes('educator'),
      refresh, refreshCourses, signOut,
    }
  }, [status, me, modules, courses, coursesError, refresh, refreshCourses, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}
export function useMe(): Me {
  const { me } = useSession()
  if (!me) throw new Error('signed out')
  return me
}
