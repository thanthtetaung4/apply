import type { FormSchema, PageSnapshot } from '../browser/types'
import type { Job } from '../shared/job'
import type { ApplyTarget, SiteType } from '../shared/status'

export type BlockKind = 'captcha' | 'login_required' | 'no_form' | 'error_page'

export interface Block {
  kind: BlockKind
  message: string
}

/**
 * A recipe holds what is specific to a kind of site. The form filling itself is schema driven and
 * shared, so recipes stay small: how to recognise blocks, confirmations and sign in sessions.
 */
export interface Recipe {
  readonly name: string
  readonly siteType: SiteType
  /** Key of the saved browser session (cookies) to load, if the site needs a sign in. */
  sessionKey(job: Job): string | undefined
  /** Button labels that dismiss cookie banners and similar overlays. */
  overlayPattern: RegExp
  detectBlock(snap: PageSnapshot, schema: FormSchema): Block | null
  isConfirmation(snap: PageSnapshot): boolean
}

const CAPTCHA =
  /captcha|verify you are human|i am not a robot|i'm not a robot|unusual traffic|are you a robot|access denied/i
const CONFIRMATION =
  /thank you for (applying|your application|submitting)|application (has been )?(submitted|received|sent)|successfully (submitted|applied)|we(?:'ve| have) received your application/i
const OVERLAY = /^(accept( all)?( cookies)?|i agree|got it|allow all( cookies)?)$/i

const BLOCKED_TEXT =
  /you have been blocked|request blocked|humans only|unusual traffic|verify you are human|are you a robot|access denied/i

/**
 * A bot protection page instead of the real one (Cloudflare and similar), as seen on Indeed
 * ("Request Blocked") and Glassdoor ("Just a moment... Humans only"). We report these and stop;
 * we do not try to get past them.
 */
export function isBlockedPage(snap: Pick<PageSnapshot, 'title' | 'text'>): boolean {
  return (
    /^just a moment|blocked|attention required/i.test(snap.title) ||
    BLOCKED_TEXT.test(snap.text.slice(0, 2000))
  )
}

/** A form that only asks for a sign in: a password plus email or user name fields. */
export function isSignInForm(schema: FormSchema): boolean {
  return (
    schema.fields.some((f) => f.type === 'password') &&
    schema.fields.every((f) => f.type === 'password' || /e-?mail|user ?name|login/i.test(f.label))
  )
}

function genericBlock(snap: PageSnapshot, schema: FormSchema): Block | null {
  if (CAPTCHA.test(snap.text) || isBlockedPage(snap)) {
    return { kind: 'captcha', message: 'The page asks to verify you are human. Apply by hand.' }
  }
  if (isSignInForm(schema)) {
    return {
      kind: 'login_required',
      message: 'The site asks you to sign in. Connect your account on the Connections page.',
    }
  }
  if (
    /^(404|page not found|not found)/i.test(snap.title) ||
    /this job (is no longer|has expired)|no longer accepting/i.test(snap.text)
  ) {
    return { kind: 'error_page', message: 'The job page is gone or closed.' }
  }
  return null
}

function make(
  name: string,
  siteType: SiteType,
  sessionKey: Recipe['sessionKey'],
  extra: Partial<Recipe> = {},
): Recipe {
  return {
    name,
    siteType,
    sessionKey,
    overlayPattern: OVERLAY,
    detectBlock: genericBlock,
    isConfirmation: (snap) => CONFIRMATION.test(snap.text),
    ...extra,
  }
}

const tenantOf = (url: string) =>
  /\/wd\/([^/]+)\//.exec(url)?.[1] ?? /\/\/([^./]+)\.[^/]*myworkdayjobs/.exec(url)?.[1]

/** Name of the saved browser session for a site, or undefined when the site needs none. */
export function sessionKeyFor(siteType: SiteType, url: string): string | undefined {
  if (siteType === 'workday') {
    const t = tenantOf(url)
    return t ? `workday-${t}` : 'workday'
  }
  return siteType === 'indeed' || siteType === 'linkedin' || siteType === 'glassdoor'
    ? siteType
    : undefined
}

export const RECIPES: Record<SiteType, Recipe> = {
  greenhouse: make('greenhouse', 'greenhouse', () => undefined),
  company_site: make('company-site', 'company_site', () => undefined),
  workday: make('workday', 'workday', (job) => sessionKeyFor('workday', job.applyUrl), {
    detectBlock(snap, schema) {
      const b = genericBlock(snap, schema)
      return b?.kind === 'login_required'
        ? {
            kind: 'login_required',
            message:
              'Workday needs you to sign in for this company. Connect it on the Connections page with this job link.',
          }
        : b
    },
  }),
  indeed: make('indeed', 'indeed', () => 'indeed'),
  linkedin: make('linkedin', 'linkedin', () => 'linkedin'),
  glassdoor: make('glassdoor', 'glassdoor', () => 'glassdoor'),
}

/** The site type decides the recipe, the config block, the daily cap and the metrics group. */
export function siteTypeOf(job: Pick<Job, 'applyTarget' | 'source'>): SiteType {
  const t: ApplyTarget = job.applyTarget
  // A board-native job is applied to on the board it came from. A link the user added ("direct")
  // or a watched careers page ("company") is never board native; treat it as a company site if it
  // ever claims to be.
  if (t === 'board_native')
    return job.source === 'direct' || job.source === 'company' ? 'company_site' : job.source
  return t
}

export const pickRecipe = (job: Pick<Job, 'applyTarget' | 'source'>): Recipe =>
  RECIPES[siteTypeOf(job)]
