import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * An in-process stand-in for the Job Search Board MCP server. Tool names and argument shapes follow
 * the real board's tools (find_duplicate, create_application, update_application, log_activity,
 * list_applications). Nothing here talks to the real board.
 */

export interface BoardApp {
  id: string
  company: string
  role: string
  stage: string
  jobLink?: string | null
  source?: string | null
  dateApplied?: string | null
  nextAction?: string | null
  notes?: string | null
  resumeVersion?: string | null
  externalId?: string | null
  matchScore?: number | null
  roleFamily?: string | null
  activities: { type: string; summary: string; externalRef?: string }[]
}

const STAGES = [
  'Wishlist',
  'Applied',
  'OA/Screening',
  'Interview - R1',
  'Interview - R2',
  'Final Interview',
  'Offer',
  'Rejected',
  'Withdrawn',
] as const
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const ok = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] })
const fail = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
})

export interface MockBoard {
  client: Client
  apps: BoardApp[]
  close(): Promise<void>
}

export async function createMockBoard(seed: Partial<BoardApp>[] = []): Promise<MockBoard> {
  const apps: BoardApp[] = seed.map((s) => ({
    id: randomUUID(),
    company: '',
    role: '',
    stage: 'Wishlist',
    activities: [],
    ...s,
  }))
  const server = new McpServer({ name: 'mock-job-search-board', version: '0.0.1' })

  server.registerTool(
    'find_duplicate',
    {
      description: 'Close matches for a company and role.',
      inputSchema: { company: z.string().min(1), role: z.string().optional() },
    },
    async ({ company, role }) => {
      const matches = apps
        .filter((a) => norm(a.company) === norm(company))
        .map((a) => ({
          id: a.id,
          company: a.company,
          role: a.role,
          stage: a.stage,
          exact: !role || norm(a.role) === norm(role),
        }))
      return ok({ matches })
    },
  )

  server.registerTool(
    'create_application',
    {
      description: 'Adds an application. Refuses exact duplicates.',
      inputSchema: {
        company: z.string().min(1),
        role: z.string().min(1),
        stage: z.enum(STAGES).default('Wishlist'),
        jobLink: z.string().nullable().optional(),
        source: z
          .enum(['LinkedIn', 'Indeed', 'Referral', 'Company Site', 'Cold Outreach', 'Other'])
          .nullable()
          .optional(),
        dateApplied: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        nextAction: z.string().max(500).nullable().optional(),
        notes: z.string().max(20000).nullable().optional(),
        resumeVersion: z
          .enum(['ATS-focused', 'AI-focused', 'Generic SWE', 'Tailored'])
          .nullable()
          .optional(),
        externalId: z.string().nullable().optional(),
        matchScore: z.number().int().min(0).max(100).nullable().optional(),
        roleFamily: z
          .enum([
            'AI Engineer',
            'Software Developer',
            'Software Engineer',
            'Full Stack',
            'Backend',
            'DevOps',
            'Other',
          ])
          .nullable()
          .optional(),
      },
    },
    async (args) => {
      if (
        apps.some((a) => norm(a.company) === norm(args.company) && norm(a.role) === norm(args.role))
      ) {
        return fail('Duplicate: the same company and role already exist')
      }
      const app: BoardApp = { id: randomUUID(), activities: [], ...args }
      apps.push(app)
      return ok({ application: app, similar: [] })
    },
  )

  server.registerTool(
    'update_application',
    {
      description: 'Partial update by id. A stage change logs a stage_change activity.',
      inputSchema: {
        id: z.string().uuid(),
        stage: z.enum(STAGES).optional(),
        dateApplied: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        nextAction: z.string().max(500).nullable().optional(),
        notes: z.string().max(20000).nullable().optional(),
        resumeVersion: z
          .enum(['ATS-focused', 'AI-focused', 'Generic SWE', 'Tailored'])
          .nullable()
          .optional(),
      },
    },
    async ({ id, ...patch }) => {
      const app = apps.find((a) => a.id === id)
      if (!app) return fail('Not found')
      if (patch.stage && patch.stage !== app.stage)
        app.activities.push({ type: 'stage_change', summary: `${app.stage} to ${patch.stage}` })
      Object.assign(
        app,
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      )
      return ok({ application: app })
    },
  )

  server.registerTool(
    'log_activity',
    {
      description:
        'Adds a timeline entry. Repeat externalRef returns the existing one with duplicate: true.',
      inputSchema: {
        applicationId: z.string().uuid(),
        type: z.enum([
          'stage_change',
          'email_sent',
          'message_sent',
          'follow_up',
          'interview',
          'note',
          'viewed',
          'resume_downloaded',
          'reply_received',
        ]),
        summary: z.string().min(1).max(2000),
        externalRef: z.string().max(300).optional(),
      },
    },
    async ({ applicationId, type, summary, externalRef }) => {
      const app = apps.find((a) => a.id === applicationId)
      if (!app) return fail('Not found')
      const existing = externalRef
        ? app.activities.find((a) => a.externalRef === externalRef)
        : undefined
      if (existing) return ok({ activity: existing, duplicate: true })
      const activity = { type, summary, externalRef }
      app.activities.push(activity)
      return ok({ activity, duplicate: false })
    },
  )

  server.registerTool(
    'list_applications',
    { description: 'List applications.', inputSchema: {} },
    async () => ok({ items: apps }),
  )

  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'auto-apply-test', version: '0.0.1' })
  await client.connect(clientT)
  return {
    client,
    apps,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
