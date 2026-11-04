// No node:fs here, so the web app can import it anywhere. Directory loading is in './fs'
// (exported as @apply/core/profile-fs).
export { AnswerBank, type AnswerMatch } from './answer-bank'
export { ProfileError, type ProfileIssue } from './issues'
export {
  parseProfile,
  PROFILE_FILES,
  PROFILE_KINDS,
  type ParseProfileOptions,
  type Profile,
  type ProfileKind,
} from './load'
export { PROFILE_TEMPLATES } from './templates'
export { appendAnswer, validateProfileFile, type FileValidation } from './validate'
export * from './types'
