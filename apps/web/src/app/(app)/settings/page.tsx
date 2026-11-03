import { getSettings } from '@apply/db'
import { SettingsForm } from '@/components/SettingsForm'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'

export default async function SettingsPage() {
  const user = await requireUser()
  const settings = await getSettings(db(), user.id)
  return (
    <>
      <div className="head">
        <div>
          <h1>Settings</h1>
          <p className="muted">How and where the app applies for you.</p>
        </div>
      </div>
      <SettingsForm settings={settings} />
    </>
  )
}
