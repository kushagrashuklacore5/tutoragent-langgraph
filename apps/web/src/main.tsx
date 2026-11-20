import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import './styles.css'
import { SessionProvider, useSession } from './session.tsx'
import { Shell } from './Shell.tsx'
import { Button, Loading, Notice } from './ui/kit.tsx'

// route-level code splitting: each screen is its own chunk
const SignIn = lazy(() => import('./pages/SignIn.tsx'))
const Verify = lazy(() => import('./pages/Verify.tsx'))
const Onboarding = lazy(() => import('./pages/Onboarding.tsx'))
const Home = lazy(() => import('./pages/Home.tsx'))
const Learn = lazy(() => import('./pages/Learn.tsx'))
const Studio = lazy(() => import('./pages/Studio.tsx'))
const Book = lazy(() => import('./pages/Book.tsx'))
const ChapterPackage = lazy(() => import('./pages/ChapterPackage.tsx'))
const Growth = lazy(() => import('./pages/Growth.tsx'))
const ExamInsights = lazy(() => import('./pages/ExamInsights.tsx'))
const Courses = lazy(() => import('./pages/Courses.tsx'))
const CourseLayout = lazy(() => import('./pages/CourseLayout.tsx'))
const Overview = lazy(() => import('./pages/Overview.tsx'))
const OpenLesson = lazy(() => import('./pages/OpenLesson.tsx'))
const PracticeDesk = lazy(() => import('./pages/PracticeDesk.tsx'))
const Materials = lazy(() => import('./pages/Materials.tsx'))
const Reader = lazy(() => import('./pages/Reader.tsx'))
const Practice = lazy(() => import('./pages/Practice.tsx'))
const Revision = lazy(() => import('./pages/Revision.tsx'))
const Plan = lazy(() => import('./pages/Plan.tsx'))
const Progress = lazy(() => import('./pages/Progress.tsx'))
const Educator = lazy(() => import('./pages/Educator.tsx'))
const EducatorCourse = lazy(() => import('./pages/EducatorCourse.tsx'))
const EducatorProgress = lazy(() => import('./pages/EducatorProgress.tsx'))
const Assessments = lazy(() => import('./pages/Assessments.tsx'))
const TakeAssessment = lazy(() => import('./pages/TakeAssessment.tsx'))
const EducatorAssessments = lazy(() => import('./pages/EducatorAssessments.tsx'))
const EducatorQuestions = lazy(() => import('./pages/EducatorQuestions.tsx'))
const Settings = lazy(() => import('./pages/Settings.tsx'))
const NotFound = lazy(() => import('./pages/NotFound.tsx'))

function Gate() {
  const s = useSession()
  const loc = useLocation()
  if (s.status === 'loading') return <div className="p-8"><Loading label="Opening your study desk" /></div>
  if (s.status === 'error') {
    return (
      <main className="mx-auto max-w-md p-6">
        <Notice tone="danger" title="Cannot reach the server">We could not load your account. Check your connection and try again.</Notice>
        <Button className="mt-4" icon="refresh" onClick={() => void s.refresh()}>Try again</Button>
      </main>
    )
  }
  if (s.status === 'signed_out') return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <Shell />
}

function App() {
  return (
    <Suspense fallback={<div className="p-8"><Loading /></div>}>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/auth/verify" element={<Verify />} />
        <Route element={<Gate />}>
          <Route index element={<Learn />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="app/education/tutor" element={<Courses />} />
          <Route path="app/education/tutor/courses/:courseId" element={<CourseLayout />}>
            <Route index element={<Overview />} />
            <Route path="tutor" element={<OpenLesson />} />
            <Route path="materials" element={<Materials />} />
            <Route path="materials/:documentId/:page" element={<Reader />} />
            <Route path="practice" element={<Practice />} />
            <Route path="assessments" element={<Assessments />} />
            <Route path="assessments/:attemptId" element={<TakeAssessment />} />
            <Route path="revision" element={<Revision />} />
            <Route path="plan" element={<Plan />} />
            <Route path="exam" element={<ExamInsights />} />
          </Route>
          <Route path="assistant" element={<Navigate to="/" replace />} />
          <Route path="practice/:courseId" element={<PracticeDesk />}>
            <Route index element={<Practice />} />
          </Route>
          <Route path="today" element={<Home />} />
          <Route path="studio" element={<Studio />} />
          <Route path="studio/:bookId" element={<Book />} />
          <Route path="studio/:bookId/package" element={<ChapterPackage />} />
          <Route path="growth" element={<Growth />} />
          <Route path="revise" element={<Revision />} />
          <Route path="progress" element={<Progress />} />
          <Route path="educator" element={<Educator />} />
          <Route path="educator/courses/:courseId" element={<EducatorCourse />} />
          <Route path="educator/courses/:courseId/progress" element={<EducatorProgress />} />
          <Route path="educator/courses/:courseId/questions" element={<EducatorQuestions />} />
          <Route path="educator/courses/:courseId/assessments" element={<EducatorAssessments />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
