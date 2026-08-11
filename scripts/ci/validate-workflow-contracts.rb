#!/usr/bin/env ruby
# frozen_string_literal: true

require 'optparse'
require 'open3'
require 'pathname'
require 'yaml'

RESULT_STATES = %w[success failure skipped cancelled].freeze

options = { root: Pathname.pwd }
OptionParser.new do |parser|
  parser.on('--root PATH', 'Repository root containing .github/workflows') do |path|
    options[:root] = Pathname(path).expand_path
  end
end.parse!

root = options.fetch(:root)
workflow_dir = root.join('.github/workflows')
errors = []

def load_workflow(path)
  YAML.safe_load(path.read, permitted_classes: [], aliases: true) || {}
rescue Psych::SyntaxError => e
  raise "#{path}: YAML parse error: #{e.message}"
end

def workflow_call(workflow)
  triggers = workflow['on'] || workflow[true] || {}
  triggers.is_a?(Hash) ? triggers['workflow_call'] : nil
end

def needs(job)
  Array(job['needs']).map(&:to_s)
end

def permissions(value)
  case value
  when nil
    nil
  when Hash
    value.transform_keys(&:to_s).transform_values(&:to_s)
  when 'read-all', 'write-all'
    { '*' => value.delete_suffix('-all') }
  when '{}'
    {}
  else
    raise "unsupported permissions value #{value.inspect}"
  end
end

def permission_level(value)
  { nil => 0, 'none' => 0, 'read' => 1, 'write' => 2 }.fetch(value)
end

def expression?(value)
  value.is_a?(String) && value.include?('${{')
end

def literal_type_matches?(value, declared_type)
  return true if expression?(value)

  case declared_type
  when 'boolean' then value == true || value == false
  when 'number' then value.is_a?(Numeric)
  when 'string' then value.is_a?(String)
  else false
  end
end

def combined_run(job)
  Array(job['steps']).map { |step| step['run'] }.compact.join("\n")
end

def two_result_cases(first_name, second_name)
  RESULT_STATES.product(RESULT_STATES).map do |first, second|
    {
      description: "#{first_name}=#{first}, #{second_name}=#{second}",
      env: { first_name => first, second_name => second },
      success: first == 'success' && second == 'success',
    }
  end
end

def validate_shell_truth_table(errors, label, script, cases)
  if script.empty?
    errors << "#{label} terminal gate has no executable shell logic"
    return
  end

  cases.each do |entry|
    _stdout, _stderr, status = Open3.capture3(entry.fetch(:env), 'bash', '-c', script)
    next if status.success? == entry.fetch(:success)

    expected = entry.fetch(:success) ? 'success' : 'failure'
    errors << "#{label} terminal truth table expected #{expected} for #{entry.fetch(:description)}"
    break
  end
end

def publication_cases
  trusted = {
    'RUN_REF' => 'refs/heads/dev',
    'RUN_SHA' => 'a' * 40,
    'WORKFLOW_SHA' => 'a' * 40,
  }
  cases = []

  %w[push workflow_dispatch].each do |event|
    RESULT_STATES.product(RESULT_STATES).each do |diff, provenance|
      expected = if event == 'push'
                   diff == 'success' && provenance == 'skipped'
                 else
                   diff == 'skipped' && provenance == 'success'
                 end
      cases << {
        description: "event=#{event}, diff=#{diff}, provenance=#{provenance}, trusted identity",
        env: trusted.merge(
          'DIFF_RESULT' => diff,
          'EVENT' => event,
          'PROVENANCE_RESULT' => provenance
        ),
        success: expected,
      }
    end
  end

  valid_dispatch = trusted.merge(
    'DIFF_RESULT' => 'skipped',
    'EVENT' => 'workflow_dispatch',
    'PROVENANCE_RESULT' => 'success'
  )
  cases << {
    description: 'workflow_dispatch with an untrusted branch',
    env: valid_dispatch.merge('RUN_REF' => 'refs/heads/feature'),
    success: false,
  }
  cases << {
    description: 'workflow_dispatch with a mismatched workflow SHA',
    env: valid_dispatch.merge('WORKFLOW_SHA' => 'b' * 40),
    success: false,
  }
  cases << {
    description: 'unsupported event',
    env: trusted.merge(
      'DIFF_RESULT' => 'success',
      'EVENT' => 'pull_request',
      'PROVENANCE_RESULT' => 'skipped'
    ),
    success: false,
  }

  cases
end

workflow_paths = Dir[workflow_dir.join('*.{yml,yaml}')].sort.map { |path| Pathname(path) }
workflows = workflow_paths.to_h { |path| [path, load_workflow(path)] }

workflows.each do |caller_path, caller|
  (caller['jobs'] || {}).each do |job_id, job|
    uses = job['uses']
    next unless uses.is_a?(String) && uses.start_with?('./.github/workflows/')

    callee_path = root.join(uses.delete_prefix('./')).cleanpath
    unless callee_path.to_s.start_with?(workflow_dir.to_s + File::SEPARATOR) && callee_path.file?
      errors << "#{caller_path.relative_path_from(root)}: job #{job_id} calls missing #{uses}"
      next
    end

    callee = workflows[callee_path] || load_workflow(callee_path)
    call = workflow_call(callee)
    unless call.is_a?(Hash)
      errors << "#{uses}: local reusable workflow does not declare on.workflow_call"
      next
    end

    declared_inputs = call['inputs'] || {}
    supplied_inputs = job['with'] || {}
    supplied_inputs.each do |name, value|
      declaration = declared_inputs[name]
      if declaration.nil?
        errors << "#{caller_path.relative_path_from(root)}: job #{job_id} supplies undeclared input #{name}"
        next
      end
      declared_type = declaration['type'].to_s
      unless literal_type_matches?(value, declared_type)
        errors << "#{caller_path.relative_path_from(root)}: job #{job_id} input #{name} " \
                  "is incompatible with #{declared_type}"
      end
    end
    declared_inputs.each do |name, declaration|
      next unless declaration['required'] == true && !supplied_inputs.key?(name)

      errors << "#{caller_path.relative_path_from(root)}: job #{job_id} omits required input #{name}"
    end

    caller_permissions = permissions(job['permissions'])
    if caller_permissions.nil?
      errors << "#{caller_path.relative_path_from(root)}: reusable job #{job_id} needs an explicit " \
                'permission ceiling'
      next
    end

    callee_default_permissions = permissions(callee['permissions'])
    (callee['jobs'] || {}).each do |callee_job_id, callee_job|
      requested = permissions(callee_job['permissions']) || callee_default_permissions
      next if requested.nil?

      requested.each do |scope, level|
        next if permission_level(level) <= permission_level(caller_permissions[scope] || caller_permissions['*'])

        errors << "#{caller_path.relative_path_from(root)}: job #{job_id} grants " \
                  "#{scope}: #{caller_permissions[scope] || caller_permissions['*'] || 'none'}, but " \
                  "#{uses} job #{callee_job_id} requests #{scope}: #{level}"
      end
    end
  end
end

formatter_path = workflow_dir.join('prettier-source-preflight.yml')
formatter = workflows[formatter_path]
if formatter
  formatter_call = workflow_call(formatter) || {}
  formatter_inputs = formatter_call.fetch('inputs', {}).keys.sort
  expected_inputs = %w[base_sha head_sha mode]
  errors << "prettier-source-preflight inputs must be #{expected_inputs.join(', ')}" unless formatter_inputs == expected_inputs
  errors << 'prettier-source-preflight must not accept secrets' unless (formatter_call['secrets'] || {}).empty?
  formatter_jobs = formatter['jobs'] || {}
  formatter_jobs.each do |job_id, job|
    requested = permissions(job['permissions']) || permissions(formatter['permissions']) || {}
    if requested['actions'] && requested['actions'] != 'none'
      errors << "prettier-source-preflight job #{job_id} must not request actions permission"
    end
  end
  formatter_conclude = formatter_jobs['conclude'] || {}
  unless (needs(formatter_conclude) & %w[validate-inputs prettier]).sort == %w[prettier validate-inputs]
    errors << 'prettier terminal result must depend on validation and the formatter'
  end
  unless formatter_conclude['if'].to_s.include?('always()')
    errors << 'prettier terminal result must run after failed or skipped prerequisites'
  end
  validate_shell_truth_table(
    errors,
    'prettier-source-preflight',
    combined_run(formatter_conclude),
    two_result_cases('VALIDATE_RESULT', 'PRETTIER_RESULT')
  )
end

provenance_path = workflow_dir.join('exact-ci-provenance.yml')
provenance = workflows[provenance_path]
if provenance
  provenance_call = workflow_call(provenance) || {}
  provenance_inputs = provenance_call.fetch('inputs', {}).keys.sort
  expected_inputs = %w[allowed_branches head_sha trusted_sha]
  errors << "exact-ci-provenance inputs must be #{expected_inputs.join(', ')}" unless provenance_inputs == expected_inputs
  errors << 'exact-ci-provenance must not accept secrets' unless (provenance_call['secrets'] || {}).empty?
  provenance_jobs = provenance['jobs'] || {}
  provenance_job = provenance_jobs['provenance'] || {}
  provenance_conclude = provenance_jobs['conclude'] || {}
  helper_runs = Array(provenance_job['steps']).map { |step| step['run'].to_s }.join("\n")
  unless helper_runs.include?('node scripts/ci/require-successful-ci-run.mjs') &&
         helper_runs.include?('--sha "$SOURCE_SHA"') &&
         helper_runs.include?('--branches "$ALLOWED_BRANCHES"')
    errors << 'exact-ci-provenance must invoke the trusted exact-SHA CI helper'
  end
  unless needs(provenance_job).include?('validate-inputs')
    errors << 'exact-ci provenance job must depend on input validation'
  end
  unless (needs(provenance_conclude) & %w[validate-inputs provenance]).sort == %w[provenance validate-inputs]
    errors << 'exact-ci terminal result must depend on validation and provenance'
  end
  unless provenance_conclude['if'].to_s.include?('always()')
    errors << 'exact-ci terminal result must fail closed for failed or skipped provenance'
  end
  validate_shell_truth_table(
    errors,
    'exact-ci-provenance',
    combined_run(provenance_conclude),
    two_result_cases('VALIDATE_RESULT', 'PROVENANCE_RESULT')
  )
  (provenance['jobs'] || {}).each do |job_id, job|
    Array(job['steps']).each do |step|
      next unless step['uses'].to_s.start_with?('actions/checkout@')

      ref = (step['with'] || {})['ref'].to_s
      errors << "exact-ci-provenance job #{job_id} must execute inputs.trusted_sha" unless ref == '${{ inputs.trusted_sha }}'
    end
  end
end

ci_public = workflows[workflow_dir.join('ci-public.yml')]
if ci_public
  jobs = ci_public.fetch('jobs', {})
  prettier = jobs['prettier'] || {}
  unless prettier['uses'] == './.github/workflows/prettier-source-preflight.yml'
    errors << 'ci-public prettier must call the contents-only formatter workflow'
  end
  prettier_permissions = permissions(prettier['permissions']) || {}
  unless prettier_permissions == { 'contents' => 'read' }
    errors << 'ci-public prettier caller must grant only contents: read'
  end
  jobs.each do |job_id, job|
    next if job_id == 'prettier'
    errors << "ci-public job #{job_id} must depend on prettier" unless needs(job).include?('prettier')
  end
end

build = workflows[workflow_dir.join('build-publish.yml')]
if build
  jobs = build.fetch('jobs', {})
  diff = jobs['incoming-diff-preflight'] || {}
  exact = jobs['exact-ci-preflight'] || {}
  terminal = jobs['preflight'] || {}
  errors << 'push publication must call the formatter workflow' unless diff['uses'] == './.github/workflows/prettier-source-preflight.yml'
  errors << 'manual publication must call exact CI provenance' unless exact['uses'] == './.github/workflows/exact-ci-provenance.yml'
  unless diff['if'].to_s.include?("github.event_name == 'push'")
    errors << 'incoming-diff publication gate must run only for push events'
  end
  exact_condition = exact['if'].to_s
  unless exact_condition.include?("github.event_name == 'workflow_dispatch'") &&
         exact_condition.include?("github.ref == 'refs/heads/dev'") &&
         exact_condition.include?('github.workflow_sha == github.sha')
    errors << 'manual publication provenance must require the trusted dev workflow revision'
  end
  errors << 'manual publication provenance must allow only dev' unless (exact['with'] || {})['allowed_branches'] == 'dev'
  unless (exact['with'] || {})['trusted_sha'] == '${{ github.workflow_sha }}'
    errors << 'manual publication provenance must execute the trusted workflow SHA'
  end
  exact_permissions = permissions(exact['permissions']) || {}
  errors << 'manual publication provenance must grant actions: read' unless exact_permissions['actions'] == 'read'
  unless (needs(terminal) & %w[incoming-diff-preflight exact-ci-preflight]).sort == %w[exact-ci-preflight incoming-diff-preflight]
    errors << 'publication preflight result must depend on both alternate-mode gates'
  end
  unless terminal['if'].to_s.include?('always()')
    errors << 'publication preflight result must fail closed across skipped alternate-mode gates'
  end
  validate_shell_truth_table(
    errors,
    'build-publish',
    combined_run(terminal),
    publication_cases
  )
  errors << 'image detection must depend on terminal publication preflight' unless needs(jobs['detect'] || {}).include?('preflight')
end

release = workflows[workflow_dir.join('release-images.yml')]
if release
  jobs = release.fetch('jobs', {})
  resolve = jobs['resolve-release-ref'] || {}
  exact = jobs['preflight'] || {}
  promote = jobs['promote'] || {}
  errors << 'release must call exact CI provenance' unless exact['uses'] == './.github/workflows/exact-ci-provenance.yml'
  errors << 'release provenance must allow only main' unless (exact['with'] || {})['allowed_branches'] == 'main'
  unless (exact['with'] || {})['trusted_sha'] == '${{ needs.resolve-release-ref.outputs.trusted_sha }}'
    errors << 'release provenance must execute the resolved trusted main SHA'
  end
  exact_permissions = permissions(exact['permissions']) || {}
  errors << 'release provenance must grant actions: read' unless exact_permissions['actions'] == 'read'
  unless (needs(promote) & %w[resolve-release-ref preflight]).sort == %w[preflight resolve-release-ref]
    errors << 'release promotion must depend on ref resolution and exact CI provenance'
  end
  unless promote['if'].to_s.include?("needs.resolve-release-ref.result == 'success'") &&
         promote['if'].to_s.include?("needs.preflight.result == 'success'")
    errors << 'release promotion must require successful ref resolution and provenance results'
  end
  [resolve, promote].each do |job|
    condition = job['if'].to_s
    unless condition.include?("github.ref == 'refs/heads/main'") &&
           condition.include?('github.workflow_sha == github.sha')
      errors << 'manual release jobs must require the trusted main workflow revision'
    end
  end
  promote_permissions = permissions(promote['permissions']) || {}
  errors << 'release promotion is expected to own the only release package write' unless promote_permissions['packages'] == 'write'
  promote_runs = Array(promote['steps']).map { |step| step['run'].to_s }.join("\n")
  errors << 'release promotion must execute the trusted promotion script' unless promote_runs.include?('bash scripts/release/promote-release-images.sh')
  promote_env = Array(promote['steps']).map { |step| step['env'] }.compact.reduce({}, :merge)
  unless promote_env['DRY_RUN'].to_s.include?("github.event_name == 'workflow_dispatch'") &&
         promote_env['TAG_SHA'].to_s.include?('needs.resolve-release-ref.outputs.sha')
    errors << 'release rehearsal must remain dry-run while the selected SHA is passed as data'
  end
  resolve_checkout = Array(resolve['steps']).find { |step| step['uses'].to_s.start_with?('actions/checkout@') }
  resolve_ref = ((resolve_checkout || {})['with'] || {})['ref'].to_s
  unless resolve_ref.include?('github.workflow_sha') && resolve_ref.include?('refs/heads/main')
    errors << 'release ref resolution must use the manual workflow SHA or trusted main'
  end
  promote_checkout = Array(promote['steps']).find { |step| step['uses'].to_s.start_with?('actions/checkout@') }
  promote_ref = ((promote_checkout || {})['with'] || {})['ref'].to_s
  unless promote_ref == '${{ needs.resolve-release-ref.outputs.trusted_sha }}'
    errors << 'release promotion must execute the resolved trusted main SHA'
  end
end

if errors.empty?
  puts "Validated #{workflow_paths.length} workflow files and all local reusable-workflow contracts."
  exit 0
end

errors.each { |error| warn "ERROR: #{error}" }
exit 1
