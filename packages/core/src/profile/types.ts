import { z } from 'zod'

const Id = z.string().regex(/^[a-z]+_[0-9a-f]{10}$/)
const NonEmpty = z.string().trim().min(1)

export const BulletSchema = z.object({ id: Id, text: NonEmpty })
export type Bullet = z.infer<typeof BulletSchema>

export const ContactSchema = z.object({
  name: NonEmpty,
  email: z.email(),
  phone: z.string().optional(),
  location: z.string().optional(),
  links: z.array(z.object({ label: NonEmpty, url: NonEmpty })),
  summary: z.string().optional(),
})
export type Contact = z.infer<typeof ContactSchema>

export const ExperienceSchema = z.object({
  id: Id,
  company: NonEmpty,
  role: NonEmpty,
  start: NonEmpty,
  end: NonEmpty,
  bullets: z.array(BulletSchema).min(1),
})
export type Experience = z.infer<typeof ExperienceSchema>

export const EducationSchema = z.object({
  id: Id,
  institution: NonEmpty,
  degree: NonEmpty,
  start: z.string().optional(),
  end: z.string().optional(),
  notes: z.array(BulletSchema),
})
export type Education = z.infer<typeof EducationSchema>

export const SkillGroupSchema = z.object({
  id: Id,
  category: NonEmpty,
  skills: z.array(NonEmpty).min(1),
})
export type SkillGroup = z.infer<typeof SkillGroupSchema>

export const ProjectSchema = z.object({
  id: Id,
  name: NonEmpty,
  stack: z.array(NonEmpty),
  link: z.string().optional(),
  role: z.string().optional(),
  period: z.string().optional(),
  description: z.string(),
  highlights: z.array(BulletSchema),
})
export type Project = z.infer<typeof ProjectSchema>

export const TitlePrefsSchema = z.object({
  titles: z.array(NonEmpty).min(1),
  keywords: z.array(NonEmpty),
  locations: z.array(NonEmpty),
  exclude: z.array(NonEmpty),
})
export type TitlePrefs = z.infer<typeof TitlePrefsSchema>

export const AnswerEntrySchema = z.object({
  id: Id,
  patterns: z.array(NonEmpty).min(1),
  answer: NonEmpty,
})
export type AnswerEntry = z.infer<typeof AnswerEntrySchema>

export const LoadedProfileSchema = z.object({
  /** Hash of all input files. Changes when any file changes (use as cache key). */
  version: z.string(),
  contact: ContactSchema,
  experience: z.array(ExperienceSchema).min(1),
  education: z.array(EducationSchema),
  skills: z.array(SkillGroupSchema).min(1),
  certifications: z.array(NonEmpty),
  projects: z.array(ProjectSchema),
  titles: TitlePrefsSchema,
  answers: z.array(AnswerEntrySchema),
})
export type LoadedProfile = z.infer<typeof LoadedProfileSchema>
