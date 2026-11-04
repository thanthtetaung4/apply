'use client'

import { useAction } from './useAction'
import { addLinksAction, startIntakeAction, startRunAction } from '@/app/actions/tasks'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

export function StartPanel({ blocked }: { blocked: string | null }) {
  const intake = useAction(startIntakeAction)
  const links = useAction(addLinksAction)
  const run = useAction(async () => startRunAction())
  return (
    <div className="two">
      <form onSubmit={intake.onSubmit}>
        <h3>1. Find jobs</h3>
        <p className="muted small">
          Searches your sources for your preferred titles and queues the good matches.
        </p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="thenRun" defaultChecked /> Start applying when the search
          finishes
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <SubmitButton busy={intake.pending} pending="Queuing...">
            Find jobs
          </SubmitButton>
        </div>
        <Messages state={intake.state} />
      </form>
      <form onSubmit={run.onSubmit}>
        <h3>2. Apply to queued jobs</h3>
        <p className="muted small">
          Makes a resume for each job and fills the forms. Sites set to review stop before
          submitting.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <SubmitButton busy={run.pending} pending="Queuing..." className="secondary">
            Apply now
          </SubmitButton>
        </div>
        <Messages state={run.state} />
      </form>
      <form onSubmit={links.onSubmit} style={{ gridColumn: '1 / -1' }}>
        <h3>Or add jobs by link</h3>
        <p className="muted small">
          Paste job pages you found yourself, one per line: a company careers page, or a
          Greenhouse, Lever or Ashby posting. Up to 20 at a time.
        </p>
        <textarea
          name="urls"
          aria-label="Job links"
          rows={3}
          placeholder="https://job-boards.greenhouse.io/company/jobs/123"
        />
        <label className="row" style={{ fontWeight: 400, marginTop: 6 }}>
          <input type="checkbox" name="thenRun" defaultChecked /> Start applying once they are
          read
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <SubmitButton busy={links.pending} pending="Queuing...">
            Add jobs
          </SubmitButton>
        </div>
        <Messages state={links.state} />
      </form>
      {blocked && (
        <p className="error small" style={{ gridColumn: '1 / -1', whiteSpace: 'pre-wrap' }}>
          {blocked}
        </p>
      )}
    </div>
  )
}
