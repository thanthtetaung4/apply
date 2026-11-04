import {
  PROFILE_FILES,
  PROFILE_KINDS,
  PROFILE_TEMPLATES,
  type ProfileKind,
} from '@apply/core/profile'
import { getProfileFiles } from '@apply/db'
import { ProfileEditor, type EditorFile } from '@/components/ProfileEditor'
import { db } from '@/lib/db'
import { profileProblem } from '@/lib/preflight'
import { requireUser } from '@/lib/session'

const LABELS: Record<ProfileKind, { label: string; help: string }> = {
  resume: {
    label: 'Resume',
    help: 'Your contact details, experience, education and skills. Tailored resumes only ever use text from here, word for word.',
  },
  titles: {
    label: 'Titles',
    help: 'Job titles to search for, keywords that make a job a better match, locations, and words that rule a job out.',
  },
  projects: {
    label: 'Projects',
    help: 'One "## Project Name" per project with a "Stack:" line, a short description and highlights.',
  },
  answers: {
    label: 'Answers',
    help: 'Answers to screening questions. Each "## Question | other wording" heading is matched against form questions. Answers you give on the Needs you page are added here.',
  },
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams
  const [saved, problem] = await Promise.all([
    getProfileFiles(db(), user.id),
    profileProblem(user.id),
  ])
  const files: EditorFile[] = PROFILE_KINDS.map((kind) => ({
    kind,
    file: PROFILE_FILES[kind],
    ...LABELS[kind],
    content: saved[kind].content,
    revision: saved[kind].revision,
    template: PROFILE_TEMPLATES[kind],
  }))

  return (
    <>
      <div className="head">
        <div>
          <h1>Profile</h1>
          <p className="muted">The four markdown files every application is built from.</p>
        </div>
      </div>
      {sp.welcome && (
        <div className="banner">
          <strong>Welcome.</strong> Replace the starter text in each file with your own details.
          Runs stay off until your resume no longer uses the starter name and email.
        </div>
      )}
      {problem && !sp.welcome && (
        <div className="banner warn" style={{ whiteSpace: 'pre-wrap' }}>
          {problem}
        </div>
      )}
      <ProfileEditor files={files} />
    </>
  )
}
