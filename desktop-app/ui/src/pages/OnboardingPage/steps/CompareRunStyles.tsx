import { Button, Card, Flex, Typography } from 'antd'

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
      <Typography.Title level={1}>Which one is right for you?</Typography.Title>
      <Flex vertical gap="middle">
        {RUN_STYLES.map(style => (
          <Card key={style.title} size="small" title={style.title}>
            <Flex vertical gap="small">
              <Typography.Paragraph type="secondary">{style.lead}</Typography.Paragraph>
              <ul>
                {style.pros.map(point => (
                  <li key={point}>
                    <Typography.Text type="success">+ {point}</Typography.Text>
                  </li>
                ))}
                {style.cons.map(point => (
                  <li key={point}>
                    <Typography.Text type="warning">− {point}</Typography.Text>
                  </li>
                ))}
              </ul>
            </Flex>
          </Card>
        ))}
      </Flex>
      <Flex vertical gap="small">
        <Button block htmlType="button" onClick={onChooseHosted} type="primary">
          Evenfire hosts it
        </Button>
        <Button block htmlType="button" onClick={onChooseSelfHosted}>
          I’ll run it myself
        </Button>
      </Flex>
    </>
  )
}
