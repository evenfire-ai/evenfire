export class DirectServiceAdmission {
  admit(): { allowed: boolean; retryAfterSeconds?: number } {
    return { allowed: true }
  }
}
