/**
 * Add an answer to the text of answers.md. Used by the "needs you" screen: the user answers a
 * question the app could not, and it is saved for every later application.
 */
export function appendAnswer(answersText: string, question: string, answer: string): string {
  const q = question
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
  const a = answer.trim()
  if (!q) throw new Error('The question is empty.')
  if (!a) throw new Error('The answer is empty.')
  if (/^#{1,6}\s/m.test(a)) throw new Error('The answer cannot contain headings.')
  const base = answersText.trim() ? answersText.replace(/\s*$/, '\n') : '# Answers\n'
  return `${base}\n## ${q}\n${a}\n`
}
