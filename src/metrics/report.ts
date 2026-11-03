import type { AppConfig } from '../config/schema'
import type { Db } from '../db'
import { SITE_TYPES, type SiteType } from '../shared/status'
import { decidePolicy } from './gate'

export interface JobLine {
  company: string
  title: string
  siteType: string
  source: string
  status: string
  backend: string
  verify: string
  steps: number
  durationMs: number
  fieldsRule: number
  fieldsBank: number
  fieldsModel: number
  reason: string
  matchScore: number | null
}

export interface SiteLine {
  siteType: SiteType
  runs: number
  submitted: number
  review: number
  needsHuman: number
  verifyPass: number
  avgSeconds: number
  configured: string
  effective: string
  gateNote: string
}

export interface ReportData {
  generatedAt: string
  totals: Record<string, number>
  jobs: JobLine[]
  sites: SiteLine[]
  llm: { calls: number; cached: number; tokensIn: number; tokensOut: number; costUsd: number }
  shadow: {
    backend: string
    runs: number
    ok: number
    compared: number
    diffs: number
    errors: string[]
  }[]
  unanswered: string[]
}

export function buildReport(db: Db, config: AppConfig, now = new Date()): ReportData {
  const jobs = db
    .prepare(
      `SELECT j.company, j.title, j.source, j.apply_target, j.match_score, a.status, a.error,
              m.backend, m.verify, m.steps, m.duration_ms, m.fields_rule, m.fields_bank, m.fields_model, m.site_type
         FROM jobs j JOIN applications a ON a.job_id = j.id LEFT JOIN metrics m ON m.job_id = j.id
        ORDER BY a.updated_at, j.id`,
    )
    .all() as Record<string, string | number | null>[]

  const lines: JobLine[] = jobs.map((r) => ({
    company: String(r.company),
    title: String(r.title),
    siteType: String(
      r.site_type ?? (r.apply_target === 'board_native' ? r.source : r.apply_target),
    ),
    source: String(r.source),
    status: String(r.status),
    backend: String(r.backend ?? ''),
    verify: String(r.verify ?? ''),
    steps: Number(r.steps ?? 0),
    durationMs: Number(r.duration_ms ?? 0),
    fieldsRule: Number(r.fields_rule ?? 0),
    fieldsBank: Number(r.fields_bank ?? 0),
    fieldsModel: Number(r.fields_model ?? 0),
    reason: String(r.error ?? ''),
    matchScore: r.match_score === null ? null : Number(r.match_score),
  }))

  const totals: Record<string, number> = {}
  for (const l of lines) totals[l.status] = (totals[l.status] ?? 0) + 1

  const sites: SiteLine[] = []
  for (const siteType of SITE_TYPES) {
    const mine = lines.filter((l) => l.siteType === siteType && l.verify !== '')
    if (mine.length === 0) continue
    const d = decidePolicy(db, config, siteType)
    sites.push({
      siteType,
      runs: mine.length,
      submitted: mine.filter((l) => l.status.startsWith('submitted')).length,
      review: mine.filter((l) => l.status === 'ready_to_submit').length,
      needsHuman: mine.filter((l) => l.status === 'needs_human').length,
      verifyPass: mine.filter((l) => l.verify === 'pass').length,
      avgSeconds: mine.reduce((n, l) => n + l.durationMs, 0) / mine.length / 1000,
      configured: d.configured,
      effective: d.effective,
      gateNote:
        d.reason ?? (d.configured !== 'auto' ? '' : config.gate.enforce ? 'bar met' : 'gate off'),
    })
  }

  const u = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cached),0) AS cached, COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS tout, COALESCE(SUM(cost_usd),0) AS cost FROM llm_usage`,
    )
    .get() as { calls: number; cached: number; ti: number; tout: number; cost: number }

  const shadowRows = db
    .prepare(
      `SELECT backend, COUNT(*) AS runs, SUM(ok) AS ok, SUM(fields_compared) AS compared, SUM(diff_count) AS diffs FROM shadow_runs GROUP BY backend`,
    )
    .all() as { backend: string; runs: number; ok: number; compared: number; diffs: number }[]
  const errors = db
    .prepare(`SELECT backend, error FROM shadow_runs WHERE ok = 0 AND error IS NOT NULL`)
    .all() as { backend: string; error: string }[]

  const unanswered = (
    db
      .prepare(`SELECT question FROM answers_seen WHERE source = 'unanswered' ORDER BY id`)
      .all() as { question: string }[]
  ).map((r) => r.question)

  return {
    generatedAt: now.toISOString(),
    totals,
    jobs: lines,
    sites,
    llm: { calls: u.calls, cached: u.cached, tokensIn: u.ti, tokensOut: u.tout, costUsd: u.cost },
    shadow: shadowRows.map((s) => ({
      backend: s.backend,
      runs: s.runs,
      ok: s.ok,
      compared: s.compared,
      diffs: s.diffs,
      errors: [...new Set(errors.filter((e) => e.backend === s.backend).map((e) => e.error))],
    })),
    unanswered,
  }
}

export function renderReportText(r: ReportData): string {
  const out: string[] = []
  out.push(`Auto Apply report  ${r.generatedAt}`)
  out.push(
    `Jobs: ${
      Object.entries(r.totals)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  )
  out.push('')
  for (const l of r.jobs) {
    out.push(
      `${l.status.padEnd(16)} ${(l.company + ' | ' + l.title).padEnd(52)} ${l.siteType.padEnd(13)} ${l.verify.padEnd(5)} ${l.reason.slice(0, 70)}`,
    )
  }
  out.push('')
  for (const s of r.sites) {
    out.push(
      `${s.siteType.padEnd(13)} runs ${s.runs}  submitted ${s.submitted}  review ${s.review}  needs human ${s.needsHuman}  verify pass ${s.verifyPass}  avg ${s.avgSeconds.toFixed(1)}s  policy ${s.configured}->${s.effective} ${s.gateNote}`,
    )
  }
  out.push('')
  out.push(
    `Model calls ${r.llm.calls} (${r.llm.cached} cached), tokens in ${r.llm.tokensIn} out ${r.llm.tokensOut}, cost $${r.llm.costUsd.toFixed(4)}`,
  )
  for (const s of r.shadow)
    out.push(
      `Shadow ${s.backend}: ${s.ok}/${s.runs} ran, ${s.compared} fields compared, ${s.diffs} differences ${s.errors.join('; ')}`,
    )
  if (r.unanswered.length) out.push(`Questions with no answer on file: ${r.unanswered.join(' | ')}`)
  return out.join('\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const STATUS_COLOR: Record<string, string> = {
  submitted: '#067647',
  submitted_unconfirmed: '#b54708',
  ready_to_submit: '#175cd3',
  needs_human: '#b42318',
  failed: '#b42318',
  skipped: '#667085',
}

export function renderReportHtml(
  r: ReportData,
  extra: { title?: string; submissions?: string } = {},
): string {
  const chip = (s: string) =>
    `<span class="chip" style="background:${STATUS_COLOR[s] ?? '#667085'}1a;color:${STATUS_COLOR[s] ?? '#667085'}">${esc(s.replace(/_/g, ' '))}</span>`
  const rows = r.jobs
    .map(
      (l) =>
        `<tr><td><b>${esc(l.company)}</b><br><span class="muted">${esc(l.title)}</span></td><td>${esc(l.siteType)}</td><td>${chip(l.status)}</td><td>${esc(l.verify || '-')}</td><td class="num">${l.steps || ''}</td><td class="num">${l.durationMs ? (l.durationMs / 1000).toFixed(1) + 's' : ''}</td><td class="num">${l.fieldsRule + l.fieldsBank + l.fieldsModel ? `${l.fieldsRule} / ${l.fieldsBank} / ${l.fieldsModel}` : ''}</td><td class="muted">${esc(l.reason)}</td></tr>`,
    )
    .join('')
  const siteRows = r.sites
    .map(
      (s) =>
        `<tr><td>${esc(s.siteType)}</td><td class="num">${s.runs}</td><td class="num">${s.submitted}</td><td class="num">${s.review}</td><td class="num">${s.needsHuman}</td><td class="num">${s.verifyPass}/${s.runs}</td><td class="num">${s.avgSeconds.toFixed(1)}s</td><td>${esc(s.configured)} to ${esc(s.effective)} <span class="muted">${esc(s.gateNote)}</span></td></tr>`,
    )
    .join('')
  const tiles = Object.entries(r.totals)
    .map(
      ([k, v]) =>
        `<div class="tile"><div class="n">${v}</div><div class="muted">${esc(k.replace(/_/g, ' '))}</div></div>`,
    )
    .join('')
  const shadow = r.shadow.length
    ? `<h2>Shadow runs</h2><table><tr><th>Backend</th><th>Ran</th><th>Fields compared</th><th>Differences</th><th>Notes</th></tr>${r.shadow.map((s) => `<tr><td>${esc(s.backend)}</td><td class="num">${s.ok}/${s.runs}</td><td class="num">${s.compared}</td><td class="num">${s.diffs}</td><td class="muted">${esc(s.errors.join('; '))}</td></tr>`).join('')}</table>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(extra.title ?? 'Auto Apply report')}</title><style>
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--ink:#101828;--muted:#667085;--line:#e4e7ec}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#eaecf0;--muted:#98a2b3;--line:#2a2f3a}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 2px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted);font-size:12.5px}.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:96px}.tile .n{font-size:26px;font-weight:650}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:block;overflow-x:auto}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}td:last-child{white-space:normal}th{font-size:12px;color:var(--muted);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}.chip{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;font-size:12px}
</style></head><body><main>
<h1>${esc(extra.title ?? 'Auto Apply report')}</h1><div class="muted">Generated ${esc(r.generatedAt)}. Fields column is rule / saved answer / model.</div>
<div class="tiles">${tiles}</div>
<h2>Applications</h2><table><tr><th>Job</th><th>Site</th><th>Status</th><th>Verify</th><th>Steps</th><th>Time</th><th>Fields</th><th>Note</th></tr>${rows}</table>
<h2>By site type</h2><table><tr><th>Site</th><th>Runs</th><th>Submitted</th><th>Review</th><th>Needs human</th><th>Verify pass</th><th>Avg time</th><th>Submit policy (configured to effective)</th></tr>${siteRows}</table>
<h2>Model usage</h2><p>${r.llm.calls} calls (${r.llm.cached} from cache), ${r.llm.tokensIn} tokens in, ${r.llm.tokensOut} out, cost $${r.llm.costUsd.toFixed(4)}.${r.llm.calls > 0 && r.llm.tokensIn === 0 ? ' <span class="muted">Offline provider in use, so token counts are zero.</span>' : ''}</p>
${shadow}
${r.unanswered.length ? `<h2>Questions with no answer on file</h2><ul>${r.unanswered.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
${extra.submissions ? `<h2>What the mock sites received</h2><pre>${esc(extra.submissions)}</pre>` : ''}
</main></body></html>`
}
