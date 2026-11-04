import type { ProfileKind } from './load'

/**
 * Starter files given to every new account. They parse, so the editor shows the format working,
 * but runs stay blocked (see `isStarterProfile` in @apply/db) until "Your Name" and
 * "you@example.com" are replaced.
 */
export const PROFILE_TEMPLATES: Record<ProfileKind, string> = {
  resume: `# Profile
Name: Your Name
Email: you@example.com
Phone: +00 0000 0000
Location: Your City

# Links
- GitHub: https://github.com/your-handle
- LinkedIn: https://linkedin.com/in/your-handle

# Summary
One or two sentences about the work you do and want to do next.

# Experience
## Company Name | Your Role | Jan 2023 - Present
- What you built or changed, and the result.
- Another achievement. Each bullet is used word for word, never invented.

## Earlier Company | Earlier Role | Jun 2021 - Dec 2022
- What you did there and why it mattered.

# Education
## University Name | Degree Name | 2017 - 2021
- Honours, awards or relevant coursework (optional)

# Skills
- Languages: TypeScript, Python, SQL
- Tools: Docker, Git, PostgreSQL

# Certifications
- Certification name (optional, delete this section if you have none)
`,
  titles: `# Titles
- Software Engineer
- Backend Developer

# Keywords
- TypeScript
- Node.js

# Locations
- Remote

# Exclude
- Director
- Intern
`,
  projects: `# Projects

## Project Name
Stack: TypeScript, Node.js, PostgreSQL
Link: https://example.com
Role: Solo developer
Period: 2025
One or two lines describing the project.
- An outcome or highlight.
`,
  answers: `# Answers

## Are you legally authorized to work in this country? | work authorization | right to work
Yes

## Will you now or in the future require visa sponsorship? | visa sponsorship | require sponsorship
No

## Earliest start date | Notice period | How soon can you start?
Available to start within 2 weeks.
`,
}
