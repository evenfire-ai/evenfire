#!/usr/bin/env ruby
# frozen_string_literal: true

require 'optparse'
require 'open3'
require 'pathname'
require 'shellwords'
require 'strscan'
require 'tmpdir'
require 'yaml'

RESULT_STATES = %w[success failure skipped cancelled].freeze

options = { root: Pathname.pwd }
OptionParser.new do |parser|
  parser.on('--root PATH', 'Repository root containing .github/workflows') do |path|
    options[:root] = Pathname(path).expand_path
  end
  parser.on('--resolve-release-executable-ref', 'Print the release resolver checkout ref') do
    options[:resolve_release_executable_ref] = true
  end
  parser.on('--event EVENT', 'Simulated event for release checkout resolution') do |event|
    options[:event] = event
  end
  parser.on('--workflow-sha SHA', 'Simulated trusted workflow SHA') do |sha|
    options[:workflow_sha] = sha
  end
  parser.on('--selected-ref REF', 'Simulated operator-selected release ref') do |ref|
    options[:selected_ref] = ref
  end
end.parse!

root = options.fetch(:root)
workflow_dir = root.join('.github/workflows')
errors = []

class GithubExpression
  Token = Struct.new(:type, :value)

  def initialize(source)
    expression = source.to_s.strip
    match = expression.match(/\A\$\{\{(.*)\}\}\z/m)
    expression = match[1] if match
    raise ArgumentError, 'expected a GitHub expression' if expression.empty?

    @tokens = tokenize(expression)
    @position = 0
  end

  def parse
    expression = parse_or
    token = peek
    raise ArgumentError, "unexpected trailing token #{token.value.inspect}" if token

    expression
  end

  def self.evaluate(source, context)
    evaluate_node(parse(source), context)
  end

  def self.parse(source)
    new(source).parse
  end

  def self.contexts(node)
    type, *values = node
    case type
    when :literal
      []
    when :context
      [values.first]
    when :equal, :not_equal, :and, :or
      (contexts(values[0]) + contexts(values[1])).uniq
    else
      raise ArgumentError, "unsupported expression node #{type.inspect}"
    end
  end

  def self.literals(node)
    type, *values = node
    case type
    when :literal
      [values.first]
    when :context
      []
    when :equal, :not_equal, :and, :or
      (literals(values[0]) + literals(values[1])).uniq
    else
      raise ArgumentError, "unsupported expression node #{type.inspect}"
    end
  end

  def self.evaluate_node(node, context)
    type, *values = node
    case type
    when :literal
      values.first
    when :context
      context.fetch(values.first)
    when :equal
      left = evaluate_node(values[0], context)
      right = evaluate_node(values[1], context)
      left.is_a?(String) && right.is_a?(String) ? left.casecmp?(right) : left == right
    when :not_equal
      left = evaluate_node(values[0], context)
      right = evaluate_node(values[1], context)
      !(left.is_a?(String) && right.is_a?(String) ? left.casecmp?(right) : left == right)
    when :and
      left = evaluate_node(values[0], context)
      truthy?(left) ? evaluate_node(values[1], context) : left
    when :or
      left = evaluate_node(values[0], context)
      truthy?(left) ? left : evaluate_node(values[1], context)
    else
      raise ArgumentError, "unsupported expression node #{type.inspect}"
    end
  end

  def self.truthy?(value)
    !value.nil? && value != false && value != 0 && value != ''
  end

  private

  def tokenize(source)
    scanner = StringScanner.new(source)
    tokens = []
    until scanner.eos?
      scanner.skip(/\s+/)
      break if scanner.eos?

      if (operator = scanner.scan(/&&|\|\||==|!=|\(|\)/))
        tokens << Token.new(operator, operator)
      elsif (string = scanner.scan(/'(?:[^']|'')*'/))
        tokens << Token.new(:literal, string[1...-1].gsub("''", "'"))
      elsif (identifier = scanner.scan(/[A-Za-z_][A-Za-z0-9_.-]*/))
        literal = { 'true' => true, 'false' => false, 'null' => nil }
        key = identifier.downcase
        tokens << if literal.key?(key)
                    Token.new(:literal, literal[key])
                  else
                    Token.new(:context, identifier)
                  end
      else
        raise ArgumentError, "unsupported token near #{scanner.rest.inspect}"
      end
    end
    tokens
  end

  def parse_or
    left = parse_and
    while accept('||')
      left = [:or, left, parse_and]
    end
    left
  end

  def parse_and
    left = parse_equality
    while accept('&&')
      left = [:and, left, parse_equality]
    end
    left
  end

  def parse_equality
    left = parse_primary
    while %w[== !=].include?(peek&.type)
      operator = advance.type
      left = [operator == '==' ? :equal : :not_equal, left, parse_primary]
    end
    left
  end

  def parse_primary
    if accept('(')
      expression = parse_or
      expect(')')
      return expression
    end

    token = advance
    raise ArgumentError, 'expression ended before an operand' unless token
    return [token.type, token.value] if %i[literal context].include?(token.type)

    raise ArgumentError, "expected an operand, got #{token.value.inspect}"
  end

  def accept(type)
    return false unless peek&.type == type

    @position += 1
    true
  end

  def expect(type)
    return if accept(type)

    raise ArgumentError, "expected #{type.inspect}, got #{peek&.value.inspect}"
  end

  def advance
    token = peek
    @position += 1 if token
    token
  end

  def peek
    @tokens[@position]
  end
end

class TerminalGate
  Token = Struct.new(:type, :value)

  def self.parse(script)
    new(script).parse
  end

  def self.evaluate(program, environment)
    case program.fetch(:type)
    when :expression
      evaluate_expression(program.fetch(:expression), environment)
    when :case
      selected = environment.fetch(program.fetch(:selector), '')
      expression = program.fetch(:arms)[selected] || program.fetch(:default)
      expression && evaluate_expression(expression, environment)
    else
      raise ArgumentError, "unsupported terminal program #{program.fetch(:type).inspect}"
    end
  end

  def self.evaluate_expression(expression, environment)
    type, *operands = expression
    case type
    when :and
      evaluate_expression(operands.fetch(0), environment) &&
        evaluate_expression(operands.fetch(1), environment)
    when :or
      evaluate_expression(operands.fetch(0), environment) ||
        evaluate_expression(operands.fetch(1), environment)
    when :equal
      value(operands.fetch(0), environment) == value(operands.fetch(1), environment)
    when :not_equal
      value(operands.fetch(0), environment) != value(operands.fetch(1), environment)
    else
      raise ArgumentError, "unsupported terminal expression #{type.inspect}"
    end
  end

  def self.value(operand, environment)
    type, value = operand
    type == :variable ? environment.fetch(value, '') : value
  end

  def initialize(script)
    @script = script.to_s.gsub(/\\\n/, ' ')
  end

  def parse
    lines = @script.lines.map(&:strip).reject(&:empty?)
    lines.shift if lines.first == 'set -euo pipefail'
    raise ArgumentError, 'terminal gate has no predicate' if lines.empty?

    source = lines.join(' ')
    program = source.start_with?('case ') ? parse_case(source) : expression_program(source)
    program.merge(variables: variables(program).uniq.sort)
  end

  private

  def parse_case(source)
    match = source.match(/\Acase\s+"\$([A-Z_][A-Z0-9_]*)"\s+in\s+(.*)\s+esac\z/m)
    raise ArgumentError, 'case gate must select one quoted variable and end with esac' unless match

    scanner = StringScanner.new(match[2])
    arms = {}
    default = nil
    default_seen = false
    until scanner.eos?
      scanner.skip(/\s+/)
      break if scanner.eos?

      label = scanner.scan(/\*|[A-Za-z0-9_.:\/-]+/)
      raise ArgumentError, "unsupported case label near #{scanner.rest.inspect}" unless label
      raise ArgumentError, "case label #{label.inspect} must end with )" unless scanner.scan(/\)/)

      body = scanner.scan_until(/;;/)
      raise ArgumentError, "case arm #{label.inspect} must end with ;;" unless body
      body = body.delete_suffix(';;').strip
      if label == '*'
        raise ArgumentError, 'case gate must contain one wildcard arm' if default_seen
        raise ArgumentError, 'default case arm must be exactly exit 1' unless body == 'exit 1'
        default = false
        default_seen = true
      else
        raise ArgumentError, 'wildcard case arm must be last' if default_seen
        raise ArgumentError, "duplicate case arm #{label.inspect}" if arms.key?(label)
        arms[label] = expression_program(body).fetch(:expression)
      end
    end
    raise ArgumentError, 'case gate must contain an exact exit 1 default arm' unless default == false

    { type: :case, selector: match[1], arms: arms, default: default }
  end

  def expression_program(source)
    @tokens = tokenize(source)
    @position = 0
    expression = parse_boolean_expression
    raise ArgumentError, "unexpected terminal token #{peek.value.inspect}" if peek

    { type: :expression, expression: expression }
  end

  def tokenize(source)
    scanner = StringScanner.new(source)
    tokens = []
    until scanner.eos?
      if scanner.skip(/\s+/)
        next
      elsif (operator = scanner.scan(/&&|\|\||!=|=|\[|\]/))
        tokens << Token.new(operator, operator)
      elsif scanner.scan(/test\b/)
        tokens << Token.new(:test, 'test')
      elsif (variable = scanner.scan(/"\$[A-Z_][A-Z0-9_]*"/))
        tokens << Token.new(:variable, variable[2...-1])
      elsif (literal = scanner.scan(/[A-Za-z0-9_.:\/-]+/))
        tokens << Token.new(:literal, literal)
      else
        raise ArgumentError, "unsupported terminal shell near #{scanner.rest.inspect}"
      end
    end
    tokens
  end

  def parse_boolean_expression
    expression = parse_predicate
    while %w[&& ||].include?(peek&.type)
      operator = take.type == '&&' ? :and : :or
      expression = [operator, expression, parse_predicate]
    end
    expression
  end

  def parse_predicate
    bracketed = accept('[')
    test_command = accept(:test) unless bracketed
    raise ArgumentError, 'terminal predicate must use [ ... ] or test' unless bracketed || test_command
    left = parse_operand
    operator = take
    unless operator && %w[= !=].include?(operator.type)
      raise ArgumentError, 'terminal predicate must use = or !='
    end
    right = parse_operand
    raise ArgumentError, 'bracketed terminal predicate must end with ]' if bracketed && !accept(']')

    [operator.type == '=' ? :equal : :not_equal, left, right]
  end

  def parse_operand
    token = take
    unless token && %i[variable literal].include?(token.type)
      raise ArgumentError, 'terminal predicate operands must be variables or literals'
    end

    [token.type, token.value]
  end

  def accept(type)
    return false unless peek&.type == type

    @position += 1
    true
  end

  def take
    token = peek
    @position += 1 if token
    token
  end

  def peek
    @tokens[@position]
  end

  def variables(program)
    found = program.fetch(:type) == :case ? [program.fetch(:selector)] : []
    expressions = if program.fetch(:type) == :case
                    program.fetch(:arms).values
                  else
                    [program.fetch(:expression)]
                  end
    expressions.each { |expression| collect_variables(expression, found) }
    found
  end

  def collect_variables(expression, found)
    type, *operands = expression
    if %i[and or].include?(type)
      operands.each { |operand| collect_variables(operand, found) }
    else
      operands.each { |operand| found << operand.fetch(1) if operand.fetch(0) == :variable }
    end
  end
end

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

def checkout_ref(job)
  checkouts = Array(job['steps']).select do |step|
    step['uses'].to_s.start_with?('actions/checkout@')
  end
  raise ArgumentError, "expected one checkout step, found #{checkouts.length}" unless checkouts.length == 1

  (checkouts.first['with'] || {})['ref'].to_s
end

def release_checkout_context(event_name:, workflow_sha:, selected_ref:)
  dispatch = event_name == 'workflow_dispatch'
  {
    'github.event.inputs.ref' => selected_ref,
    'github.event_name' => event_name,
    'github.ref' => dispatch ? 'refs/heads/main' : "refs/tags/#{selected_ref}",
    'github.ref_name' => dispatch ? 'main' : selected_ref,
    'github.sha' => dispatch ? workflow_sha : selected_ref,
    'github.workflow_sha' => workflow_sha,
    'inputs.ref' => selected_ref,
  }
end

def resolve_release_executable_ref(release, event_name:, workflow_sha:, selected_ref:)
  resolve_job = (release['jobs'] || {}).fetch('resolve-release-ref')
  GithubExpression.evaluate(
    checkout_ref(resolve_job),
    release_checkout_context(
      event_name: event_name,
      workflow_sha: workflow_sha,
      selected_ref: selected_ref
    )
  ).to_s
end

def execute_provenance_step(script, helper_exit:, source_sha:, allowed_branches:)
  Dir.mktmpdir('evenfire-provenance-contract') do |directory|
    shim = Pathname(directory).join('node')
    log = Pathname(directory).join('arguments')
    shim.write(<<~SH)
      #!/bin/sh
      printf '%s\\0' "$@" >> "$PROVENANCE_SHIM_LOG"
      exit #{helper_exit}
    SH
    shim.chmod(0o700)
    env = {
      'ALLOWED_BRANCHES' => allowed_branches,
      'HOME' => directory,
      'PATH' => directory,
      'PROVENANCE_SHIM_LOG' => log.to_s,
      'SOURCE_SHA' => source_sha,
    }
    stdout, stderr, status = Open3.capture3(
      env,
      '/bin/bash', '--noprofile', '--norc', '-e', '-c', script,
      chdir: directory,
      unsetenv_others: true
    )
    arguments = log.file? ? log.binread.split("\0") : []
    [stdout, stderr, status, arguments]
  end
end

def validate_provenance_step(errors, provenance_workflow, provenance_job)
  steps = Array(provenance_job['steps'])
  unless steps.length == 2
    errors << 'exact-ci-provenance must contain exactly trusted checkout followed by the helper'
    return
  end

  checkout_step, helper_step = steps
  unless checkout_step['uses'].to_s.match?(/\Aactions\/checkout@[0-9a-f]{40}\z/) &&
         checkout_step['with'] == {
           'fetch-depth' => 1,
           'persist-credentials' => false,
           'ref' => '${{ inputs.trusted_sha }}',
         }
    errors << 'exact-ci-provenance must begin with the pinned trusted-SHA checkout'
  end
  %w[if continue-on-error].each do |control|
    errors << "exact-ci-provenance checkout step must not set #{control}" if checkout_step.key?(control)
  end

  unless helper_step['run'].is_a?(String)
    errors << 'exact-ci-provenance trusted checkout must be followed by the helper run step'
    return
  end
  script = helper_step.fetch('run')
  expected_tokens = [
    'node',
    'scripts/ci/require-successful-ci-run.mjs',
    '--sha',
    '$SOURCE_SHA',
    '--branches',
    '$ALLOWED_BRANCHES',
  ]
  begin
    actual_tokens = Shellwords.split(script)
  rescue ArgumentError => e
    errors << "exact-ci-provenance helper command is invalid: #{e.message}"
    return
  end
  unless actual_tokens == expected_tokens
    errors << 'exact-ci-provenance helper must be the exact variable-derived command without wrappers'
    return
  end

  expected_env = {
    'ALLOWED_BRANCHES' => '${{ inputs.allowed_branches }}',
    'GITHUB_TOKEN' => '${{ github.token }}',
    'SOURCE_SHA' => '${{ inputs.head_sha }}',
  }
  unless helper_step['env'] == expected_env
    errors << 'exact-ci-provenance helper environment must use the exact provenance inputs and token'
  end

  %w[if continue-on-error shell working-directory].each do |control|
    errors << "exact-ci-provenance helper step must not set #{control}" if helper_step.key?(control)
  end
  if provenance_job.key?('continue-on-error')
    errors << 'exact-ci-provenance job must not set continue-on-error'
  end
  if provenance_workflow.key?('defaults') || provenance_job.key?('defaults')
    errors << 'exact-ci-provenance helper must not use workflow or job run defaults'
  end
  if provenance_workflow.key?('env') || provenance_job.key?('env')
    errors << 'exact-ci-provenance helper must not inherit workflow or job environment overrides'
  end
  unless provenance_job['runs-on'] == 'ubuntu-latest'
    errors << 'exact-ci-provenance helper must run on the trusted ubuntu-latest runner contract'
  end
  if provenance_job.key?('container') || provenance_job.key?('services')
    errors << 'exact-ci-provenance helper must not use container or service execution overrides'
  end

  [
    ['a' * 40, 'main'],
    ['b' * 40, 'dev'],
  ].each do |source_sha, allowed_branches|
    expected_arguments = [
      'scripts/ci/require-successful-ci-run.mjs',
      '--sha',
      source_sha,
      '--branches',
      allowed_branches,
    ]
    _stdout, _stderr, success_status, success_arguments = execute_provenance_step(
      script,
      helper_exit: 0,
      source_sha: source_sha,
      allowed_branches: allowed_branches
    )
    unless success_status.success? && success_arguments == expected_arguments
      errors << 'exact-ci-provenance must expand the exact SHA and allowed branches into helper arguments'
      next
    end

    _stdout, _stderr, failure_status, failure_arguments = execute_provenance_step(
      script,
      helper_exit: 23,
      source_sha: source_sha,
      allowed_branches: allowed_branches
    )
    unless failure_arguments == expected_arguments
      errors << 'exact-ci-provenance failure path must invoke the trusted exact-SHA CI helper'
    end
    if failure_status.success?
      errors << "exact-ci-provenance must propagate helper failure for #{allowed_branches}"
    end
  end
end

def normalized_shell(script)
  script.to_s.lines.each_with_object([]) do |line, kept|
    stripped = line.strip
    kept << stripped unless stripped.empty? || stripped.start_with?('#')
  end.join("\n")
end

def validate_release_resolution(errors, resolve_job)
  expected_outputs = {
    'sha' => '${{ steps.resolve.outputs.sha }}',
    'trusted_sha' => '${{ steps.resolve.outputs.trusted_sha }}',
  }
  errors << 'release resolver outputs must preserve selected and trusted SHA authority' \
    unless resolve_job['outputs'] == expected_outputs

  steps = Array(resolve_job['steps'])
  unless steps.length == 2
    errors << 'release resolver must contain exactly trusted checkout followed by ref peeling'
    return
  end

  checkout, peel = steps
  checkout_with = checkout['with'] || {}
  unless checkout['uses'].to_s.match?(/\Aactions\/checkout@[0-9a-f]{40}\z/) &&
         checkout_with.keys.sort == %w[fetch-depth persist-credentials ref] &&
         checkout_with['fetch-depth'] == 0 &&
         checkout_with['persist-credentials'] == false
    errors << 'release resolver must begin with the pinned trusted checkout contract'
  end
  %w[if continue-on-error].each do |control|
    errors << "release resolver checkout must not set #{control}" if checkout.key?(control)
  end

  expected_peel = <<~'SH'.strip
    set -euo pipefail
    trusted_sha="$(git rev-parse HEAD)"
    if [[ "$RELEASE_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
    candidate="$RELEASE_REF"
    if ! git cat-file -e "${candidate}^{commit}" 2>/dev/null; then
    git fetch --no-tags origin "$candidate"
    fi
    else
    git check-ref-format --branch "$RELEASE_REF" >/dev/null
    git fetch --force origin "$RELEASE_REF"
    candidate=FETCH_HEAD
    fi
    sha="$(git rev-parse --verify --end-of-options "${candidate}^{commit}")"
    echo "sha=$sha" >> "$GITHUB_OUTPUT"
    echo "trusted_sha=$trusted_sha" >> "$GITHUB_OUTPUT"
  SH
  unless peel['name'] == 'Peel release ref to its commit' && peel['id'] == 'resolve' &&
         peel['env'] == { 'RELEASE_REF' => '${{ github.event.inputs.ref || github.ref_name }}' } &&
         normalized_shell(peel['run']) == expected_peel
    errors << 'release resolver must keep selected ref as data and bind trusted SHA to checkout HEAD'
  end
  %w[if continue-on-error shell working-directory].each do |control|
    errors << "release resolver peel step must not set #{control}" if peel.key?(control)
  end

  unless resolve_job['runs-on'] == 'ubuntu-latest'
    errors << 'release resolver must run on the trusted ubuntu-latest runner contract'
  end
  if resolve_job.key?('container') || resolve_job.key?('services') ||
     resolve_job.key?('defaults') || resolve_job.key?('env')
    errors << 'release resolver must not use execution-environment overrides'
  end
end

def validate_release_promotion(errors, release_workflow, promote_job)
  steps = Array(promote_job['steps'])
  unless steps.length == 5
    errors << 'release promotion must keep the trusted five-step execution topology'
    return
  end

  checkout, fetch_data, install_crane, login, execute = steps
  unless checkout['uses'].to_s.match?(/\Aactions\/checkout@[0-9a-f]{40}\z/) &&
         checkout['with'] == {
           'fetch-depth' => 0,
           'persist-credentials' => false,
           'ref' => '${{ needs.resolve-release-ref.outputs.trusted_sha }}',
         }
    errors << 'release promotion must begin with the pinned resolved trusted-SHA checkout'
  end
  %w[if continue-on-error].each do |control|
    errors << "release promotion checkout must not set #{control}" if checkout.key?(control)
  end

  expected_fetch = <<~'SH'.strip
    set -euo pipefail
    if ! git cat-file -e "${TAG_SHA}^{commit}" 2>/dev/null; then
      git fetch --no-tags origin "$TAG_SHA"
    fi
    git cat-file -e "${TAG_SHA}^{commit}"
  SH
  unless fetch_data['name'] == 'Fetch the selected release commit as data' &&
         fetch_data['env'] == { 'TAG_SHA' => '${{ needs.resolve-release-ref.outputs.sha }}' } &&
         fetch_data['run'].to_s.strip == expected_fetch
    errors << 'release promotion must fetch the selected SHA through the exact data-only step'
  end
  %w[if continue-on-error shell working-directory].each do |control|
    errors << "release data-fetch step must not set #{control}" if fetch_data.key?(control)
  end

  expected_install = <<~'SH'.strip
    set -euo pipefail
    VER=v0.20.2
    curl -fsSL "https://github.com/google/go-containerregistry/releases/download/${VER}/go-containerregistry_Linux_x86_64.tar.gz" \
    | sudo tar -xz -C /usr/local/bin crane
    crane version
  SH
  unless install_crane['name'] == 'Install crane' &&
         !install_crane.key?('env') &&
         normalized_shell(install_crane['run']) == expected_install
    errors << 'release promotion must retain the trusted crane installation step'
  end
  %w[if continue-on-error shell working-directory].each do |control|
    errors << "release crane installation must not set #{control}" if install_crane.key?(control)
  end

  unless login['name'] == 'Log in to ghcr.io' &&
         login['uses'].to_s.match?(/\Adocker\/login-action@[0-9a-f]{40}\z/) &&
         login['with'] == {
           'registry' => 'ghcr.io',
           'username' => '${{ github.actor }}',
           'password' => '${{ secrets.GITHUB_TOKEN }}',
         }
    errors << 'release promotion must retain the pinned GHCR login contract'
  end

  expected_execute_env = {
    'DRY_RUN' => "${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}",
    'RELEASE_REF' => '${{ github.event.inputs.ref || github.ref_name }}',
    'TAG_SHA' => '${{ needs.resolve-release-ref.outputs.sha }}',
  }
  unless execute['name'] == 'Resolve and promote' &&
         execute['env'] == expected_execute_env &&
         Shellwords.split(execute['run'].to_s) == ['bash', 'scripts/release/promote-release-images.sh']
    errors << 'release promotion must execute the trusted promoter with selected values as data only'
  end
  %w[if continue-on-error shell working-directory].each do |control|
    errors << "release promotion helper must not set #{control}" if execute.key?(control)
  end

  unless promote_job['runs-on'] == 'ubuntu-latest'
    errors << 'release promotion must run on the trusted ubuntu-latest runner contract'
  end
  if release_workflow.key?('defaults') || release_workflow.key?('env') ||
     promote_job.key?('container') || promote_job.key?('services') ||
     promote_job.key?('defaults') || promote_job.key?('env')
    errors << 'release promotion must not use execution-environment overrides'
  end
rescue ArgumentError => e
  errors << "release promotion command is invalid: #{e.message}"
end

def validate_release_conditions(errors, resolve_job, promote_job)
  repository = 'evenfire-ai/evenfire'
  begin
    resolve_ast = GithubExpression.parse(resolve_job['if'])
    promote_ast = GithubExpression.parse(promote_job['if'])
    literals = (GithubExpression.literals(resolve_ast) + GithubExpression.literals(promote_ast)).uniq
    refs = literals.grep(/\Arefs\//) + ['refs/tags/v1.0.0', 'refs/heads/feature']
    repositories = literals.grep(%r{\A(?!refs/)[^/]+/[^/]+\z}) + [repository, 'fork/evenfire']
    shas = literals.grep(/\A[0-9a-fA-F]{40}\z/) + ['a' * 40, 'b' * 40]
    cases = %w[push workflow_dispatch].product(refs.uniq, repositories.uniq, shas.uniq, shas.uniq).map do |event, ref, repo, workflow_sha, sha|
      trusted = repo.casecmp?(repository) &&
                (event != 'workflow_dispatch' ||
                  (ref.casecmp?('refs/heads/main') && workflow_sha.casecmp?(sha)))
      {
        description: "event=#{event}, ref=#{ref}, repo=#{repo}, workflow_sha=#{workflow_sha}, sha=#{sha}",
        context: {
          'github.event_name' => event,
          'github.ref' => ref,
          'github.repository' => repo,
          'github.sha' => sha,
          'github.workflow_sha' => workflow_sha,
        },
        trusted: trusted,
      }
    end

    cases.each do |entry|
      actual = GithubExpression.truthy?(GithubExpression.evaluate_node(resolve_ast, entry.fetch(:context)))
      next if actual == entry.fetch(:trusted)

      errors << "release resolver event guard violates trust table for #{entry.fetch(:description)}"
      break
    end

    cases.each do |entry|
      RESULT_STATES.product(RESULT_STATES).each do |resolve_result, preflight_result|
        context = entry.fetch(:context).merge(
          'needs.preflight.result' => preflight_result,
          'needs.resolve-release-ref.result' => resolve_result
        )
        expected = entry.fetch(:trusted) &&
                   resolve_result == 'success' &&
                   preflight_result == 'success'
        actual = GithubExpression.truthy?(GithubExpression.evaluate_node(promote_ast, context))
        next if actual == expected

        errors << "release promotion event guard violates trust table for #{entry.fetch(:description)}, " \
                  "resolve=#{resolve_result}, preflight=#{preflight_result}"
        return
      end
    end
  rescue KeyError, ArgumentError => e
    errors << "release event guard expression is invalid: #{e.message}"
  end
end

def validate_release_triggers(errors, release_workflow)
  triggers = release_workflow['on'] || release_workflow[true] || {}
  push = triggers['push'] || {}
  dispatch = triggers['workflow_dispatch'] || {}
  dispatch_inputs = dispatch['inputs'] || {}
  ref_input = dispatch_inputs['ref'] || {}

  unless triggers.keys.sort == %w[push workflow_dispatch] &&
         push == { 'tags' => ['v*'] } &&
         dispatch_inputs.keys == ['ref'] &&
         ref_input['required'] == true
    errors << 'release workflow must trigger only on v* tags or one required manual ref input'
  end
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

def validate_shell_truth_table(
  errors, label, workflow, job, cases, expected_environment,
  expected_type:, case_labels: [], expected_workflow_environment: {}
)
  steps = Array(job['steps'])
  unless steps.length == 1 && steps.first['run'].is_a?(String)
    errors << "#{label} terminal gate must contain exactly one run step"
    return
  end
  errors << "#{label} terminal job must run on ubuntu-latest" unless job['runs-on'] == 'ubuntu-latest'

  errors << "#{label} workflow must not set defaults" if workflow.key?('defaults')
  workflow_environment = workflow['env'] || {}
  unless workflow_environment == expected_workflow_environment
    errors << "#{label} workflow environment must match its exact safe bindings"
  end
  %w[continue-on-error env defaults container services].each do |control|
    errors << "#{label} terminal job must not set #{control}" if job.key?(control)
  end
  step = steps.first
  %w[if continue-on-error shell working-directory].each do |control|
    errors << "#{label} terminal step must not set #{control}" if step.key?(control)
  end
  step_environment = step['env'] || {}
  unless step_environment == expected_environment
    errors << "#{label} terminal environment must use the exact result and event bindings"
  end

  begin
    program = TerminalGate.parse(step.fetch('run'))
  rescue ArgumentError => e
    errors << "#{label} terminal gate syntax is unsupported: #{e.message}"
    return
  end
  allowed_variables = expected_environment.keys
  unexpected_variables = program.fetch(:variables) - allowed_variables
  unless unexpected_variables.empty?
    errors << "#{label} terminal gate uses unsupported variables: #{unexpected_variables.join(', ')}"
    return
  end
  unless program.fetch(:type) == expected_type
    errors << "#{label} terminal gate must use a #{expected_type} program"
    return
  end
  if expected_type == :case && program.fetch(:arms).keys.sort != case_labels.sort
    errors << "#{label} terminal case modes must be exactly #{case_labels.sort.join(', ')}"
    return
  end

  cases.each do |entry|
    result = TerminalGate.evaluate(program, entry.fetch(:env))
    next if result == entry.fetch(:success)

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

if options[:resolve_release_executable_ref]
  required_options = %i[event workflow_sha selected_ref]
  missing_options = required_options.reject { |name| options.key?(name) }
  unless missing_options.empty?
    warn "ERROR: release checkout resolution requires #{missing_options.join(', ')}"
    exit 1
  end

  release = workflows[workflow_dir.join('release-images.yml')]
  unless release
    warn 'ERROR: release-images.yml is unavailable'
    exit 1
  end

  begin
    puts resolve_release_executable_ref(
      release,
      event_name: options.fetch(:event),
      workflow_sha: options.fetch(:workflow_sha),
      selected_ref: options.fetch(:selected_ref)
    )
    exit 0
  rescue KeyError, ArgumentError => e
    warn "ERROR: cannot resolve release executable checkout: #{e.message}"
    exit 1
  end
end

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
    formatter,
    formatter_conclude,
    two_result_cases('VALIDATE_RESULT', 'PRETTIER_RESULT'),
    {
      'PRETTIER_RESULT' => '${{ needs.prettier.result }}',
      'VALIDATE_RESULT' => '${{ needs.validate-inputs.result }}',
    },
    expected_type: :expression,
    expected_workflow_environment: {}
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
  validate_provenance_step(errors, provenance, provenance_job)
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
    provenance,
    provenance_conclude,
    two_result_cases('VALIDATE_RESULT', 'PROVENANCE_RESULT'),
    {
      'PROVENANCE_RESULT' => '${{ needs.provenance.result }}',
      'VALIDATE_RESULT' => '${{ needs.validate-inputs.result }}',
    },
    expected_type: :expression,
    expected_workflow_environment: {}
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
    build,
    terminal,
    publication_cases,
    {
      'DIFF_RESULT' => '${{ needs.incoming-diff-preflight.result }}',
      'EVENT' => '${{ github.event_name }}',
      'PROVENANCE_RESULT' => '${{ needs.exact-ci-preflight.result }}',
      'RUN_REF' => '${{ github.ref }}',
      'RUN_SHA' => '${{ github.sha }}',
      'WORKFLOW_SHA' => '${{ github.workflow_sha }}',
    },
    expected_type: :case,
    case_labels: %w[push workflow_dispatch],
    expected_workflow_environment: {
      'NAMESPACE' => 'evenfire-ai',
      'REGISTRY' => 'ghcr.io',
    }
  )
  errors << 'image detection must depend on terminal publication preflight' unless needs(jobs['detect'] || {}).include?('preflight')
end

release = workflows[workflow_dir.join('release-images.yml')]
if release
  validate_release_triggers(errors, release)
  jobs = release.fetch('jobs', {})
  resolve = jobs['resolve-release-ref'] || {}
  exact = jobs['preflight'] || {}
  promote = jobs['promote'] || {}
  validate_release_resolution(errors, resolve)
  validate_release_promotion(errors, release, promote)
  validate_release_conditions(errors, resolve, promote)
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
  promote_permissions = permissions(promote['permissions']) || {}
  errors << 'release promotion is expected to own the only release package write' unless promote_permissions['packages'] == 'write'
  promote_runs = Array(promote['steps']).map { |step| step['run'].to_s }.join("\n")
  errors << 'release promotion must execute the trusted promotion script' unless promote_runs.include?('bash scripts/release/promote-release-images.sh')
  promote_env = Array(promote['steps']).map { |step| step['env'] }.compact.reduce({}, :merge)
  unless promote_env['DRY_RUN'].to_s.include?("github.event_name == 'workflow_dispatch'") &&
         promote_env['TAG_SHA'].to_s.include?('needs.resolve-release-ref.outputs.sha')
    errors << 'release rehearsal must remain dry-run while the selected SHA is passed as data'
  end
  begin
    resolve_ast = GithubExpression.parse(checkout_ref(resolve))
    allowed_contexts = %w[github.event_name github.workflow_sha]
    untrusted_contexts = GithubExpression.contexts(resolve_ast) - allowed_contexts
    unless untrusted_contexts.empty?
      errors << 'release executable checkout must ignore selected refs and unknown contexts: ' \
                "#{untrusted_contexts.sort.join(', ')}"
    end
    sha_classes = GithubExpression.literals(resolve_ast).grep(/\A[0-9a-fA-F]{40}\z/)
    sha_classes.concat(['a' * 40, 'b' * 40]).uniq!
    sha_classes.each do |workflow_sha|
      dispatch_result = resolve_release_executable_ref(
        release,
        event_name: 'workflow_dispatch',
        workflow_sha: workflow_sha,
        selected_ref: 'malicious-candidate'
      )
      tag_result = resolve_release_executable_ref(
        release,
        event_name: 'push',
        workflow_sha: workflow_sha,
        selected_ref: 'malicious-candidate'
      )
      unless dispatch_result == workflow_sha && tag_result == 'refs/heads/main'
        errors << 'release executable checkout must ignore selected refs and choose workflow SHA or trusted main'
        break
      end
    end
  rescue KeyError, ArgumentError => e
    errors << "release executable checkout expression is invalid: #{e.message}"
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
