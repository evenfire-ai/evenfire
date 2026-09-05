import { Button } from '@components/Common'

interface CompareRunStylesProps {
  onChooseHosted: () => void
  onChooseSelfHosted: () => void
}

interface RunStyleSummary {
  title: string
  lead: string
  pros: string[]
  cons: string[]
}

/**
 * Q2's undecided answer: the two run styles side by side.
 *
 * Framed around the requirements that actually force the decision rather than
 * generic benefits — someone who does not know which to pick is not weighing
 * preferences, they are checking whether a constraint applies to them. So the
 * self-hosted side reads as a checklist of those constraints, and hosting is
 * positioned as the default when none of them do.
 *
 * Deliberately limited to operational trade-offs. No pricing or trial claims:
 * hosted signup does not exist yet, so anything about cost would be a promise
 * the product cannot keep. Self-hosting is described as "a cluster you
 * control" rather than anything local, because it covers remote and local.
 */
const RUN_STYLES: RunStyleSummary[] = [
  {
    title: 'Evenfire hosts it',
    lead: 'The default if none of the requirements below apply to you.',
    pros: ['Nothing to deploy, upgrade, or monitor', 'Fastest way to a working agent'],
    cons: ['Runs on Evenfire’s infrastructure, not yours'],
  },
  {
    title: 'You run it yourself',
    lead: 'Choose this if any of these are true:',
    pros: [
      'Data or model keys are not allowed to leave your own network',
      'Agents must reach internal systems that are not on the public internet',
      'Policy or compliance dictates where your data is processed and stored',
      'You need to set your own network policy, egress rules, and upgrade schedule',
    ],
    cons: ['You deploy and maintain the cluster'],
  },
]

export function CompareRunStyles({ onChooseHosted, onChooseSelfHosted }: CompareRunStylesProps) {
  return (
    <>
      <h1>Which one is right for you?</h1>
      <div className="onboarding-compare">
        {RUN_STYLES.map(style => (
          <section className="onboarding-compare__group" key={style.title}>
            <h2 className="onboarding-compare__title">{style.title}</h2>
            <p className="onboarding-compare__lead">{style.lead}</p>
            <ul className="onboarding-compare__list">
              {style.pros.map(point => (
                <li className="onboarding-compare__item" key={point}>
                  <span
                    className="onboarding-compare__mark onboarding-compare__mark--pro"
                    aria-hidden="true"
                  >
                    +
                  </span>
                  <span>{point}</span>
                </li>
              ))}
              {style.cons.map(point => (
                <li className="onboarding-compare__item" key={point}>
                  <span
                    className="onboarding-compare__mark onboarding-compare__mark--con"
                    aria-hidden="true"
                  >
                    −
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="auth-flow-card__actions">
        <Button block onClick={onChooseHosted}>
          Evenfire hosts it
        </Button>
        <Button block variant="soft" onClick={onChooseSelfHosted}>
          I’ll run it myself
        </Button>
      </div>
    </>
  )
}
