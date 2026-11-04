export interface ProfileIssue {
  file: string
  message: string
}

export class IssueCollector {
  readonly issues: ProfileIssue[] = []
  add(file: string, message: string): void {
    this.issues.push({ file, message })
  }
  get hasIssues(): boolean {
    return this.issues.length > 0
  }
}

export class ProfileError extends Error {
  constructor(readonly issues: ProfileIssue[]) {
    super(
      `Profile has ${issues.length} problem${issues.length === 1 ? '' : 's'}:\n` +
        issues.map((i) => `  - ${i.file}: ${i.message}`).join('\n'),
    )
    this.name = 'ProfileError'
  }
}
