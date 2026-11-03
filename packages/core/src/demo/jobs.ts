/** Fictional jobs served by the mock job sites. No real company, person or site is involved. */

export type MockSource = 'indeed' | 'linkedin' | 'glassdoor'

export type ApplyKind =
  | 'greenhouse'
  | 'greenhouse_unknown_question'
  | 'greenhouse_eeo'
  | 'greenhouse_captcha'
  | 'company_single'
  | 'company_wizard'
  | 'workday'
  | 'linkedin_easy_apply'
  | 'indeed_apply'

export interface MockJob {
  id: string
  source: MockSource
  title: string
  company: string
  slug: string
  location: string
  description: string
  kind: ApplyKind
  /** Path (on the mock server) where the employer application lives. */
  applyPath: string
  /** True when the board's own flow is used and no employer redirect exists. */
  boardNative?: boolean
}

export const MOCK_JOBS: MockJob[] = [
  {
    id: '1',
    source: 'indeed',
    title: 'AI Engineer',
    company: 'Lumen AI',
    slug: 'lumen-ai',
    location: 'Singapore',
    description:
      'Build and evaluate LLM features for enterprise customers. You will design prompts, RAG pipelines and regression evaluation suites in Python and TypeScript, and work with PostgreSQL.',
    kind: 'greenhouse',
    applyPath: '/gh/lumen-ai/jobs/101',
  },
  {
    // Same job as #1 found on another board. Intake must dedupe it.
    id: '2',
    source: 'linkedin',
    title: 'AI Engineer',
    company: 'Lumen AI',
    slug: 'lumen-ai',
    location: 'Singapore',
    description:
      'Build and evaluate LLM features for enterprise customers. You will design prompts, RAG pipelines and regression evaluation suites in Python and TypeScript, and work with PostgreSQL.',
    kind: 'greenhouse',
    applyPath: '/gh/lumen-ai/jobs/101',
  },
  {
    id: '3',
    source: 'indeed',
    title: 'Backend Developer',
    company: 'Harbor Pay',
    slug: 'harborpay',
    location: 'Singapore',
    description:
      'Own payment services written in Node.js and TypeScript. PostgreSQL and Redis experience required. You will write integration tests and improve reliability of REST APIs.',
    kind: 'greenhouse_eeo',
    applyPath: '/gh/harborpay/jobs/102',
  },
  {
    id: '4',
    source: 'linkedin',
    title: 'Software Engineer',
    company: 'Northstar Logistics',
    slug: 'northstar',
    location: 'Singapore',
    description:
      'Build internal tools for dispatch teams using TypeScript, Node.js and PostgreSQL. REST API design and automated testing are part of daily work.',
    kind: 'company_single',
    applyPath: '/co/northstar/careers/201',
  },
  {
    id: '5',
    source: 'glassdoor',
    title: 'Software Engineer (AI Platform)',
    company: 'Quanta Cloud',
    slug: 'quanta',
    location: 'Singapore',
    description:
      'Join the AI platform team. Python and TypeScript services, LLM tooling, evaluation, and Kubernetes-based deployment.',
    kind: 'company_wizard',
    applyPath: '/co/quanta/careers/202',
  },
  {
    id: '6',
    source: 'glassdoor',
    title: 'AI Engineer',
    company: 'Meridian Bank',
    slug: 'meridian',
    location: 'Singapore',
    description:
      'Apply LLM evaluation and prompt design to internal banking assistants. Python, SQL and strong testing discipline expected.',
    kind: 'workday',
    applyPath: '/wd/meridian/job/301',
  },
  {
    id: '7',
    source: 'linkedin',
    title: 'Software Engineer',
    company: 'Atlas Retail',
    slug: 'atlas',
    location: 'Singapore',
    description:
      'Work on retail assistant products with TypeScript and Node.js. Experience with multi-tenant design and AI assistants is a plus.',
    kind: 'linkedin_easy_apply',
    applyPath: '/linkedin/jobs/view/7',
    boardNative: true,
  },
  {
    id: '8',
    source: 'indeed',
    title: 'Software Developer',
    company: 'BrightPath Learning',
    slug: 'brightpath',
    location: 'Singapore',
    description:
      'Build a flashcard and learning app with Flutter and Supabase. Offline-first sync experience and TypeScript for backend functions.',
    kind: 'indeed_apply',
    applyPath: '/indeed/apply/501',
    boardNative: true,
  },
  {
    id: '9',
    source: 'linkedin',
    title: 'Backend Developer',
    company: 'NovaTech',
    slug: 'novatech',
    location: 'Singapore',
    description:
      'Backend development with Node.js, Redis and PostgreSQL. Strong communication and team leadership skills are valued.',
    kind: 'greenhouse_unknown_question',
    applyPath: '/gh/novatech/jobs/103',
  },
  {
    id: '10',
    source: 'glassdoor',
    title: 'AI Engineer',
    company: 'ShadyCorp',
    slug: 'shadycorp',
    location: 'Singapore',
    description: 'AI engineering role. LLM, Python and evaluation experience.',
    kind: 'greenhouse_captcha',
    applyPath: '/gh/shadycorp/jobs/104',
  },
  {
    id: '11',
    source: 'indeed',
    title: 'Senior Manager, Engineering',
    company: 'BigCo',
    slug: 'bigco',
    location: 'Singapore',
    description: 'Lead a department of 40 engineers. People management and budgeting.',
    kind: 'greenhouse',
    applyPath: '/gh/bigco/jobs/105',
  },
  {
    id: '12',
    source: 'indeed',
    title: 'Sales Representative',
    company: 'RetailCo',
    slug: 'retailco',
    location: 'Singapore',
    description: 'Sell retail products to walk-in customers. Target driven.',
    kind: 'greenhouse',
    applyPath: '/gh/retailco/jobs/106',
  },
]

export const jobsBySource = (source: MockSource) => MOCK_JOBS.filter((j) => j.source === source)
export const jobById = (id: string) => MOCK_JOBS.find((j) => j.id === id)
