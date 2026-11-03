'use client'

import { useAction } from './useAction'
import { answerQuestionAction } from '@/app/actions/tasks'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'

export function AnswerForm({ question }: { question: string }) {
  const { state, onSubmit, pending } = useAction(answerQuestionAction)
  return (
    <form onSubmit={onSubmit} style={{ marginTop: 8 }}>
      <input type="hidden" name="question" value={question} />
      <label htmlFor={`a-${question}`}>{question}</label>
      <textarea
        id={`a-${question}`}
        name="answer"
        required
        rows={3}
        placeholder="Your answer, in the first person. It is saved to answers.md and reused."
      />
      <div className="row" style={{ marginTop: 8 }}>
        <SubmitButton busy={pending} pending="Saving...">
          Save answer and retry
        </SubmitButton>
      </div>
      <Messages state={state} />
    </form>
  )
}
