const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSandboxUiTeamId(value: string): boolean {
  return UUID_RE.test(value)
}

export function sandboxUiTeamGrantsCte(projection: 'exists' | 'recipe'): string {
  const select = projection === 'exists' ? '1' : 'twt.recipe_namespace, twt.recipe_name'

  return `team_grants AS (
         SELECT ${select}
         FROM team_members tm
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
         JOIN ui_recipes ui
           ON ui.recipe_namespace = twt.recipe_namespace
          AND ui.recipe_name = twt.recipe_name
         WHERE tm.user_id = $1
           AND $2::uuid IS NOT NULL
           AND tm.team_id = $2::uuid
           AND tm.status = 'active'
       )`
}
