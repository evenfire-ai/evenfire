export async function admitHostMessage(verifiedSubject: string) {
  const result = await checkAndIncrementStrict(`host-message-admission:${verifiedSubject}`, 60)
  return { status: result.backendAvailable ? 'allowed' : 'unavailable' }
}

export function respondHostMessageAdmissionFailure(res: any, result: any): void {
  res.status(result.backendAvailable ? 429 : 503).json({ error: 'message_admission_failed' })
}

async function checkAndIncrementStrict(_key: string, _limit: number) {
  return { backendAvailable: true, allowed: true }
}
