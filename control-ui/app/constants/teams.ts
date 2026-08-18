/**
 * The full Teams setup how-to, linked from the prerequisites block on both the
 * create and edit Communication Channel pages. Mirrors SLACK_NEW_APP_URL: an
 * external-facing address both pages need, so it lives here instead of inline
 * in one of them.
 *
 * This file lives on `main` only from the next promotion onward, so the link
 * 404s until then. That is accepted: pointing at `dev` instead would teach
 * operators to trust an unstable doc location.
 */
export const TEAMS_SETUP_GUIDE_URL =
  'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/connect-teams.md'
