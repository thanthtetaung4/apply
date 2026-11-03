import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { jobById, MOCK_JOBS, type MockJob, type MockSource } from './jobs'
import {
  boardSearch,
  boardView,
  captchaPage,
  companySinglePage,
  companyWizardPage,
  greenhousePage,
  indeedApplyPage,
  layout,
  thanksPage,
  workdayJob,
  workdaySignIn,
} from './pages'

/** URL rules that tell intake which mock employer pages are Greenhouse, Workday or company sites. */
export const MOCK_TARGET_RULES: {
  pattern: RegExp
  target: 'greenhouse' | 'workday' | 'company_site'
}[] = [
  { pattern: /\/gh\//, target: 'greenhouse' },
  { pattern: /\/wd\//, target: 'workday' },
  { pattern: /\/co\//, target: 'company_site' },
]

export interface Submission {
  company: string
  jobId: string
  kind: string
  at: string
  fields: Record<string, string>
  /** Uploaded file name and size, by field name. */
  files: Record<string, { filename: string; size: number }>
}

export interface MockServer {
  url: string
  submissions: Submission[]
  reset(): void
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** Minimal multipart/form-data parser. Enough for the mock forms. */
export function parseMultipart(body: Buffer, contentType: string) {
  const fields: Record<string, string> = {}
  const files: Record<string, { filename: string; size: number }> = {}
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return { fields, files }
  const boundary = Buffer.from('--' + (m[1] ?? m[2]))
  let pos = body.indexOf(boundary)
  while (pos !== -1) {
    const next = body.indexOf(boundary, pos + boundary.length)
    if (next === -1) break
    const part = body.subarray(pos + boundary.length + 2, next - 2) // trim CRLF around the part
    const split = part.indexOf('\r\n\r\n')
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8')
      const data = part.subarray(split + 4)
      const name = /name="([^"]*)"/.exec(head)?.[1]
      const filename = /filename="([^"]*)"/.exec(head)?.[1]
      if (name) {
        if (filename !== undefined) {
          if (filename) files[name] = { filename, size: data.length }
        } else {
          fields[name] = data.toString('utf8')
        }
      }
    }
    pos = next
  }
  return { fields, files }
}

function send(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(html)
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2) as [string, string][],
  )
}

const REQUIRED: Record<string, string[]> = {
  greenhouse: ['first_name', 'last_name', 'email', 'work_auth', 'sponsorship'],
  company_single: ['full_name', 'email', 'phone', 'privacy'],
  company_wizard: ['first_name', 'last_name', 'email', 'phone', 'work_auth'],
  workday: ['wd_first', 'wd_last', 'wd_email', 'wd_phone', 'wd_company', 'wd_auth', 'wd_sponsor'],
  linkedin_easy_apply: ['ea_email', 'ea_phone', 'ea_auth', 'ea_sponsor'],
  indeed_apply: ['ia_name', 'ia_email', 'ia_phone'],
}

export async function startMockServer(port = 0): Promise<MockServer> {
  const submissions: Submission[] = []
  let origin = ''

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      origin = `http://${req.headers.host}`
      const path = url.pathname

      // Boards: search pages
      const searchMatch: [RegExp, MockSource][] = [
        [/^\/indeed\/jobs$/, 'indeed'],
        [/^\/linkedin\/jobs\/search$/, 'linkedin'],
        [/^\/glassdoor\/Job\/jobs\.htm$/, 'glassdoor'],
      ]
      for (const [re, source] of searchMatch)
        if (re.test(path)) return send(res, 200, boardSearch(source))

      // Boards: job view pages
      const view =
        (path === '/indeed/viewjob' && jobById(url.searchParams.get('jk') ?? '')) ||
        (/^\/linkedin\/jobs\/view\/\d+$/.test(path) && jobById(path.split('/').pop() ?? '')) ||
        (/^\/glassdoor\/job-listing\/\d+$/.test(path) && jobById(path.split('/').pop() ?? ''))
      if (view) return send(res, 200, boardView(view as MockJob, origin))

      // Employer pages: find the job whose applyPath matches
      const submitMatch = /^(.*)\/submit$/.exec(path)
      const basePath = submitMatch ? submitMatch[1]! : path
      const job = MOCK_JOBS.find((j) => j.applyPath === basePath)

      if (job && req.method === 'POST' && submitMatch) {
        const body = await readBody(req)
        const ct = req.headers['content-type'] ?? ''
        const { fields, files } = ct.includes('multipart')
          ? parseMultipart(body, ct)
          : { fields: Object.fromEntries(new URLSearchParams(body.toString())), files: {} }
        const kindKey = job.kind.startsWith('greenhouse') ? 'greenhouse' : job.kind
        const missing = (REQUIRED[kindKey] ?? []).filter((k) => !fields[k])
        if (job.kind === 'greenhouse_unknown_question' && !fields.conflict) missing.push('conflict')
        if (missing.length) {
          return send(
            res,
            422,
            layout(
              'Error',
              `<main><h1>Please fix the errors</h1><p class="error" role="alert">Missing: ${missing.join(', ')}</p></main>`,
            ),
          )
        }
        submissions.push({
          company: job.company,
          jobId: job.id,
          kind: job.kind,
          at: new Date().toISOString(),
          fields,
          files,
        })
        return send(res, 200, thanksPage(job.company))
      }

      if (job && req.method === 'GET') {
        switch (job.kind) {
          case 'greenhouse':
          case 'greenhouse_eeo':
          case 'greenhouse_unknown_question':
            return send(res, 200, greenhousePage(job))
          case 'greenhouse_captcha':
            return send(res, 200, captchaPage(job))
          case 'company_single':
            return send(res, 200, companySinglePage(job))
          case 'company_wizard':
            return send(res, 200, companyWizardPage(job))
          case 'workday':
            return send(
              res,
              200,
              cookies(req).wd_sid === job.slug ? workdayJob(job) : workdaySignIn(job),
            )
          case 'indeed_apply':
            return send(res, 200, indeedApplyPage(job))
          case 'linkedin_easy_apply':
            return send(res, 200, boardView(job, origin))
        }
      }

      // Workday sign in
      const signin = /^\/wd\/([^/]+)\/signin$/.exec(path)
      if (signin && req.method === 'POST') {
        const wd = MOCK_JOBS.find((j) => j.kind === 'workday' && j.slug === signin[1])
        if (!wd) return send(res, 404, layout('Not found', '<main><h1>Not found</h1></main>'))
        return send(res, 302, '', {
          location: wd.applyPath,
          'set-cookie': `wd_sid=${wd.slug}; Path=/; HttpOnly`,
        })
      }

      if (path === '/__submissions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(submissions, null, 2))
      }
      if (path === '/') {
        return send(
          res,
          200,
          layout(
            'Mock job sites',
            '<main><h1>Mock job sites</h1><p>Local fictional sites for testing Auto Apply.</p></main>',
          ),
        )
      }
      send(res, 404, layout('Not found', '<main><h1>Not found</h1></main>'))
    } catch (err) {
      send(res, 500, layout('Error', `<main><pre>${String(err)}</pre></main>`))
    }
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    submissions,
    reset: () => void (submissions.length = 0),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
