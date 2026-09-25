#!/usr/bin/env bash
set -euo pipefail

# Contract for Docker builds that consume workspace packages through
# `file:../packages/*`.  A package must be in the build context before the
# npm install that resolves it.  Next.js builds additionally require a real
# node_modules copy because its bundler does not reliably follow workspace
# symlinks.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGES_MANIFEST="$REPO_ROOT/deploy/images.json"
BUILD_PUBLISH_WORKFLOW="$REPO_ROOT/.github/workflows/build-publish.yml"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

line_of_first() {
  local file="$1"
  local pattern="$2"
  awk -v pattern="$pattern" 'index($0, pattern) { print NR; exit }' "$file"
}

line_of_last() {
  local file="$1"
  local pattern="$2"
  awk -v pattern="$pattern" 'index($0, pattern) { line=NR } END { if (line) print line }' "$file"
}

assert_copy_before_first_ci() {
  local file="$1"
  local package="$2"
  local copy_line ci_line
  copy_line="$(line_of_first "$REPO_ROOT/$file" "COPY packages/$package")"
  ci_line="$(line_of_first "$REPO_ROOT/$file" "RUN npm ci")"
  if [[ -z "$copy_line" || -z "$ci_line" || "$copy_line" -ge "$ci_line" ]]; then
    fail "$file must COPY packages/$package before its first npm ci"
  fi
}

assert_copy_before_every_ci() {
  local file="$1"
  local packages=(${@:2})
  local current_stage=0
  local copied=""
  local line_no=0
  local line package

  while IFS= read -r line; do
    line_no=$((line_no + 1))
    if [[ "$line" == FROM\ * ]]; then
      current_stage=$((current_stage + 1))
      copied=""
      continue
    fi
    for package in "${packages[@]}"; do
      if [[ "$line" == "COPY packages/$package"* ]]; then
        copied="$copied|$package|"
      fi
    done
    if [[ "$line" == "RUN npm ci"* ]]; then
      for package in "${packages[@]}"; do
        if [[ "$copied" != *"|$package|"* ]]; then
          fail "$file stage $current_stage must COPY packages/$package before npm ci at line $line_no"
        fi
      done
    fi
  done < "$REPO_ROOT/$file"
}

assert_copy_before_last_ci() {
  local file="$1"
  local package="$2"
  local copy_line ci_line
  copy_line="$(line_of_last "$REPO_ROOT/$file" "COPY packages/$package")"
  ci_line="$(line_of_last "$REPO_ROOT/$file" "RUN npm ci")"
  if [[ -z "$copy_line" || -z "$ci_line" || "$copy_line" -ge "$ci_line" ]]; then
    fail "$file must COPY packages/$package before its last npm ci"
  fi
}

assert_copy_before_service_ci() {
  local file="$1"
  local service="$2"
  shift 2
  local packages=("$@")
  local copied=""
  local workdir=""
  local line_no=0
  local line package

  while IFS= read -r line; do
    line_no=$((line_no + 1))
    if [[ "$line" == FROM\ * ]]; then
      copied=""
      workdir=""
      continue
    fi
    if [[ "$line" == WORKDIR\ * ]]; then
      workdir="${line#WORKDIR }"
    fi
    for package in "${packages[@]}"; do
      if [[ "$line" == "COPY packages/$package"* ]]; then
        copied="$copied|$package|"
      fi
    done
    if [[ "$line" == "RUN npm ci"* && "$workdir" == */"$service" ]]; then
      for package in "${packages[@]}"; do
        if [[ "$copied" != *"|$package|"* ]]; then
          fail "$file must COPY packages/$package before service npm ci at line $line_no"
        fi
      done
    fi
  done < "$REPO_ROOT/$file"
}

assert_materialized() {
  local file="$1"
  local package="$2"
  local expected="cp -R ../packages/$package node_modules/@clerum/$package"
  if ! grep -Fq "$expected" "$REPO_ROOT/$file"; then
    fail "$file must materialize @clerum/$package in node_modules"
  fi
}

assert_dockerignore_allows() {
  local file="$1"
  local package="$2"
  local ignore="$REPO_ROOT/$file"
  if ! grep -Fq "!packages/$package/" "$ignore" || \
     ! grep -Fq "!packages/$package/**" "$ignore"; then
    fail "$file must explicitly allow packages/$package in its Docker context"
  fi
}

assert_dockerignore_excludes_generated_dependencies() {
  local file="$1"
  local package="$2"
  local ignore="$file"
  local allow_line exclude_line
  if [[ "$ignore" != /* ]]; then
    ignore="$REPO_ROOT/$file"
  fi
  allow_line="$(
    awk -v pattern="!packages/$package/" \
      '$0 == pattern { line=NR } END { if (line) print line }' "$ignore"
  )"
  exclude_line="$(
    awk -v pattern="packages/$package/node_modules/" \
      '$0 == pattern { line=NR } END { if (line) print line }' "$ignore"
  )"
  if [[ -z "$allow_line" || -z "$exclude_line" || "$exclude_line" -le "$allow_line" ]]; then
    fail "$file must exclude packages/$package/node_modules from its Docker context"
  fi
}

assert_dockerignore_narrow_package() {
  local file="$1"
  local package="$2"
  local ignore="$file"
  local expected actual
  if [[ "$ignore" != /* ]]; then
    ignore="$REPO_ROOT/$file"
  fi
  expected="$(printf '%s\n' \
    "!packages/$package/" \
    "!packages/$package/package.json" \
    "!packages/$package/src/" \
    "!packages/$package/src/index.tsx" \
    "!packages/$package/styles.css")"
  actual="$(awk -v prefix="!packages/$package/" 'index($0, prefix) == 1 { print }' "$ignore")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$file must allow exactly the tracked packages/$package build files"
  fi
}

assert_dockerignore_mutations_rejected() {
  local fixture_dir negated_node_modules extra_secret
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-dockerignore-contract.XXXXXX")"
  negated_node_modules="$fixture_dir/negated-node-modules"
  extra_secret="$fixture_dir/extra-secret"

  printf '%s\n' \
    '!packages/frontend-components/' \
    '!packages/frontend-components/package.json' \
    '!packages/frontend-components/src/' \
    '!packages/frontend-components/src/index.tsx' \
    '!packages/frontend-components/styles.css' \
    '!packages/frontend-components/node_modules/' > "$negated_node_modules"
  local before="$failures"
  assert_dockerignore_excludes_generated_dependencies \
    "$negated_node_modules" frontend-components 2>/dev/null
  if [[ "$failures" -eq "$before" ]]; then
    fail 'Docker context contract must reject a negated node_modules rule'
  else
    failures="$before"
  fi

  printf '%s\n' \
    '!packages/frontend-components/' \
    '!packages/frontend-components/package.json' \
    '!packages/frontend-components/src/' \
    '!packages/frontend-components/src/index.tsx' \
    '!packages/frontend-components/styles.css' \
    '!packages/frontend-components/.env' \
    'packages/frontend-components/node_modules/' > "$extra_secret"
  before="$failures"
  assert_dockerignore_narrow_package "$extra_secret" frontend-components 2>/dev/null
  if [[ "$failures" -eq "$before" ]]; then
    fail 'Docker context contract must reject an extra package-scoped allow rule'
  else
    failures="$before"
  fi

  rm -rf -- "$fixture_dir"
}

declared_local_packages() {
  local service="$1"
  node -e '
    const manifest = require(process.argv[1]);
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const [name, value] of Object.entries(dependencies)) {
      const match = /^@clerum\/(.+)$/.exec(name);
      if (match && typeof value === "string" && value.startsWith("file:../packages/")) {
        console.log(match[1]);
      }
    }
  ' "$REPO_ROOT/$service/package.json"
}

assert_declared_local_packages() {
  local service="$1"
  shift
  local packages=()
  local package file
  while IFS= read -r package; do
    [[ -n "$package" ]] && packages+=("$package")
  done < <(declared_local_packages "$service")
  if (( ${#packages[@]} == 0 )); then
    return
  fi
  for file in "$@"; do
    assert_copy_before_service_ci "$file" "$(basename "$service")" "${packages[@]}"
  done
}

assert_declared_local_package_sources() {
  local image="$1"
  local service="$2"
  local package expected
  while IFS= read -r package; do
    [[ -z "$package" ]] && continue
    expected="packages/$package/**"
    if ! node -e '
      const manifest = require(process.argv[1]);
      const [imageName, expected] = process.argv.slice(2);
      const image = manifest.images.find(candidate => candidate.name === imageName);
      process.exit(image?.source_paths?.includes(expected) ? 0 : 1);
    ' "$IMAGES_MANIFEST" "$image" "$expected"; then
      fail "$image publish sources must include declared local package $expected"
    fi
  done < <(declared_local_packages "$service")
}

build_publish_matrix_rows() {
  ruby -rjson -ryaml -e '
    manifest = JSON.parse(File.read(ARGV[0]))
    workflow = YAML.load_file(ARGV[1])
    published = manifest.fetch("images").select { |image| image["published"] == true }
    matrix = workflow.fetch("jobs").fetch("build-push").fetch("strategy").fetch("matrix")
    matrix.fetch("include").each do |row|
      rooted = row["rooted"] == true
      dockerfile = row.fetch("dockerfile", "Dockerfile")
      puts [row.fetch("image"), row.fetch("path"), dockerfile, rooted].join("\t")
    end
  ' "$IMAGES_MANIFEST" "$BUILD_PUBLISH_WORKFLOW"
}

manifest_published_rows() {
  node -e '
    const manifest = require(process.argv[1]);
    for (const image of manifest.images.filter(candidate => candidate.published === true)) {
      console.log([
        image.name,
        image.path,
        image.dockerfile ?? "Dockerfile",
        image.rooted === true,
      ].join("\t"));
    }
  ' "$IMAGES_MANIFEST"
}

assert_independent_workspace_image_population() {
  local output rc
  output="$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const manifest = require(process.argv[2]);
    const buildScriptPath = path.join(root, "scripts/minikube/build-images.sh");
    const buildScript = fs.readFileSync(buildScriptPath, "utf8");
    const published = manifest.images.filter(image => image.published === true);
    const problems = [];

    function localPackages(service) {
      const packagePath = path.join(root, service, "package.json");
      if (!fs.existsSync(packagePath)) return [];
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      return Object.entries({
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
        ...(packageJson.optionalDependencies ?? {}),
      }).filter(([name, value]) =>
        name.startsWith("@clerum/") &&
        typeof value === "string" &&
        value.startsWith("file:../packages/")
      );
    }

    function localRef(image) {
      return `clerum/${image.local_name ?? image.name}:${image.local_tag ?? "test"}`;
    }

    // Filesystem artifacts are independent of the publication declarations.
    // A top-level workspace-package consumer with a real Dockerfile must not
    // disappear merely because both manifest and workflow rows were edited.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || localPackages(entry.name).length === 0) continue;
      for (const file of fs.readdirSync(path.join(root, entry.name))) {
        if (!/^Dockerfile(?:\.[^.]+)?$/.test(file)) continue;
        const dockerfile = path.join(root, entry.name, file);
        const text = fs.readFileSync(dockerfile, "utf8");
        if (!/^\s*FROM\s+/m.test(text)) continue;
        const matches = published.filter(image =>
          image.path === entry.name && (image.dockerfile ?? "Dockerfile") === file
        );
        if (matches.length === 0) {
          problems.push(`${entry.name}/${file}: no published image row`);
        }
      }
    }

    // Executable local build targets preserve image identity and multiplicity
    // when several images share one service or Dockerfile.
    const lines = buildScript.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (!/^\s*build_image\s+/.test(lines[lineIndex])) continue;
      let call = lines[lineIndex];
      while (/\\\s*$/.test(call.split("\n").at(-1)) && lineIndex + 1 < lines.length) {
        call += `\n${lines[++lineIndex]}`;
      }
      const args = [...call.matchAll(/"([^"]+)"/g)].map(match => match[1]);
      if (args.length < 3) continue;
      const [, context, tag, explicitDockerfile] = args;
      let dockerfile = explicitDockerfile ?? `${context}/Dockerfile`;
      dockerfile = dockerfile
        .replace(/^\$\{PROJECT_DIR\}\//, "")
        .replace(/^\$\{PROJECT_DIR\}$/, "Dockerfile");
      let service = path.dirname(dockerfile);
      if (service === ".") {
        service = context
          .replace(/^\$\{PROJECT_DIR\}\//, "")
          .replace(/^\$\{PROJECT_DIR\}$/, "");
      }
      if (!service || localPackages(service).length === 0) continue;
      const relativeDockerfile = path.relative(service, dockerfile) || "Dockerfile";
      const matches = published.filter(image => localRef(image) === tag);
      if (matches.length !== 1) {
        problems.push(`${tag}: expected one published image row, found ${matches.length}`);
        continue;
      }
      const image = matches[0];
      if (image.path !== service || (image.dockerfile ?? "Dockerfile") !== relativeDockerfile) {
        problems.push(
          `${tag}: build target is ${service}/${relativeDockerfile}, manifest is ` +
          `${image.path}/${image.dockerfile ?? "Dockerfile"}`
        );
      }
    }

    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
  ' "$REPO_ROOT" "$IMAGES_MANIFEST" 2>&1)" && rc=0 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "independent workspace image population mismatch:\n$output"
  fi
}

assert_manifest_matches_build_publish_matrix() {
  local manifest_rows matrix_rows diff_output
  if ! manifest_rows="$(manifest_published_rows | LC_ALL=C sort)"; then
    fail "published image manifest could not be read"
    return
  fi
  if ! matrix_rows="$(build_publish_matrix_rows | LC_ALL=C sort)"; then
    fail "Build & Publish image matrix could not be read"
    return
  fi
  if [[ -z "$manifest_rows" || -z "$matrix_rows" ]]; then
    fail 'published image and Build & Publish populations must both be non-empty'
    return
  fi
  if diff_output="$(diff -u <(printf '%s\n' "$manifest_rows") <(printf '%s\n' "$matrix_rows"))"; then
    return
  fi
  fail "published image rows disagree with the Build & Publish matrix:\n$diff_output"
}

assert_manifest_declared_local_packages() {
  local rows_file expected_rows actual_rows row image service dockerfile
  rows_file="$(mktemp "${TMPDIR:-/tmp}/evenfire-published-images.XXXXXX")"
  if ! node -e '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    const root = process.argv[2];
    const published = manifest.images.filter(candidate => candidate.published === true);

    if (published.length === 0) {
      console.error("published image population must not be empty");
      process.exit(1);
    }

    let invalid = false;
    for (const image of published) {
      const packageJson = `${root}/${image.path}/package.json`;
      const dockerfile = `${image.path}/${image.dockerfile ?? "Dockerfile"}`;
      const dockerfilePath = `${root}/${dockerfile}`;
      if (!fs.existsSync(dockerfilePath)) {
        console.error(`published image ${image.name} is missing ${dockerfile}`);
        invalid = true;
      }
      if (!fs.existsSync(packageJson)) {
        const claimsWorkspacePackages = image.source_paths?.some(path =>
          path.startsWith("packages/")
        );
        const dockerfileText = fs.existsSync(dockerfilePath)
          ? fs.readFileSync(dockerfilePath, "utf8")
          : "";
        const copiesLocalManifest = /^\s*COPY\s+package(?:\.json|\*\.json)\b/m.test(
          dockerfileText
        );
        if (copiesLocalManifest || claimsWorkspacePackages) {
          console.error(`Node/workspace image ${image.name} is missing ${image.path}/package.json`);
          invalid = true;
        }
      }
      console.log([image.name, image.path, dockerfile].join("\t"));
    }
    if (published.length === 0) {
      console.error("published image population must not be empty");
      invalid = true;
    }
    if (invalid) process.exit(1);
  ' "$IMAGES_MANIFEST" "$REPO_ROOT" >"$rows_file"; then
    rm -f -- "$rows_file"
    fail 'published image population must be complete and point to existing package.json files'
    return
  fi

  expected_rows="$(build_publish_matrix_rows | wc -l | tr -d '[:space:]')"
  actual_rows="$(wc -l <"$rows_file" | tr -d '[:space:]')"
  if [[ "$actual_rows" != "$expected_rows" ]]; then
    rm -f -- "$rows_file"
    fail "published image derivation omitted entries ($actual_rows of $expected_rows)"
    return
  fi

  while IFS=$'\t' read -r image service dockerfile; do
    [[ -z "$image" ]] && continue
    if [[ -f "$REPO_ROOT/$service/package.json" ]]; then
      assert_declared_local_packages "$service" "$dockerfile"
      assert_declared_local_package_sources "$image" "$service"
    fi
  done <"$rows_file"
  rm -f -- "$rows_file"
}

assert_manifest_source_mutations_rejected() {
  local fixture_dir fixture_manifest fixture_workflow before real_manifest real_workflow
  local mutation_name mutation
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-publish-sources.XXXXXX")"
  real_manifest="$IMAGES_MANIFEST"
  real_workflow="$BUILD_PUBLISH_WORKFLOW"

  expect_manifest_rejection() {
    mutation_name="$1"
    mutation="$2"
    fixture_manifest="$fixture_dir/${mutation_name}.json"
    node -e "$mutation" "$real_manifest" "$fixture_manifest"
    IMAGES_MANIFEST="$fixture_manifest"
    before="$failures"
    assert_manifest_declared_local_packages 2>/dev/null
    IMAGES_MANIFEST="$real_manifest"
    if [[ "$failures" -eq "$before" ]]; then
      fail "manifest mutation must be rejected: $mutation_name"
    else
      failures="$before"
    fi
  }

  expect_manifest_rejection all-unpublished '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    for (const image of manifest.images) image.published = false;
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection missing-package-json '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    for (const image of manifest.images) {
      if (image.published) image.path = "tests/fixtures/missing-published-package";
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection control-api-missing-package-json '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    const image = manifest.images.find(candidate => candidate.name === "control-api");
    image.path = "tests/fixtures/missing-control-api-package";
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection rpc-proxy-missing-local-source '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    const image = manifest.images.find(candidate => candidate.name === "rpc-proxy");
    image.source_paths = image.source_paths.filter(path => path !== "packages/action-context-contracts/**");
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection control-api-gutted-sources '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    const image = manifest.images.find(candidate => candidate.name === "control-api");
    image.source_paths = ["control-api/**"];
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection workflow-recipes-gutted-sources '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    for (const name of ["workflow-recipes", "workflow-coordinator", "workflow-snippet-runner"]) {
      const image = manifest.images.find(candidate => candidate.name === name);
      image.source_paths = ["workflow-recipes/**"];
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection host-context-controller-gutted-sources '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    const image = manifest.images.find(candidate => candidate.name === "host-context-controller");
    image.source_paths = ["host-context-controller/**"];
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '
  expect_manifest_rejection published-image-missing-build-matrix '
    const fs = require("node:fs");
    const manifest = require(process.argv[1]);
    manifest.images.push({
      name: "synthetic-published-image",
      path: "workflow-recipes",
      source_paths: ["workflow-recipes/**"],
      published: true,
    });
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
  '

  expect_coordinated_artifact_omission() {
    local case_name="$1"
    local replacement_path="$2"
    shift 2
    fixture_manifest="$fixture_dir/${case_name}.json"
    fixture_workflow="$fixture_dir/${case_name}.yml"
    node -e '
      const fs = require("node:fs");
      const manifest = require(process.argv[1]);
      const output = process.argv[2];
      const replacementPath = process.argv[3];
      const names = new Set(process.argv.slice(4));
      for (const image of manifest.images) {
        if (!names.has(image.name)) continue;
        image.path = replacementPath;
        image.source_paths = [`${replacementPath}/**`];
      }
      fs.writeFileSync(output, JSON.stringify(manifest));
    ' "$real_manifest" "$fixture_manifest" "$replacement_path" "$@"
    ruby -ryaml -e '
      workflow = YAML.load_file(ARGV.shift)
      output = ARGV.shift
      replacement = ARGV.shift
      names = ARGV.to_h { |name| [name, true] }
      rows = workflow.fetch("jobs").fetch("build-push").fetch("strategy").fetch("matrix").fetch("include")
      rows.each { |row| row["path"] = replacement if names[row["image"]] }
      File.write(output, YAML.dump(workflow))
    ' "$real_workflow" "$fixture_workflow" "$replacement_path" "$@"
    IMAGES_MANIFEST="$fixture_manifest"
    BUILD_PUBLISH_WORKFLOW="$fixture_workflow"
    before="$failures"
    assert_independent_workspace_image_population 2>/dev/null
    assert_manifest_declared_local_packages 2>/dev/null
    IMAGES_MANIFEST="$real_manifest"
    BUILD_PUBLISH_WORKFLOW="$real_workflow"
    if [[ "$failures" -eq "$before" ]]; then
      fail "coordinated artifact omission must be rejected: $case_name"
    else
      failures="$before"
    fi
  }

  expect_coordinated_artifact_omission \
    profile-ui-coordinated-omission mcp-servers/playwright profile-ui
  expect_coordinated_artifact_omission \
    host-context-controller-coordinated-omission mcp-servers/playwright \
    host-context-controller
  expect_coordinated_artifact_omission \
    workflow-recipes-coordinated-omission mcp-servers/playwright \
    workflow-recipes workflow-coordinator workflow-snippet-runner

  rm -rf -- "$fixture_dir"
}

assert_root_build_context() {
  local selector="$1"
  local block
  block="$(grep -A4 -F "build_image \"$selector\"" "$REPO_ROOT/scripts/minikube/build-images.sh")"
  if [[ "$block" != *'"${PROJECT_DIR}"'* || "$block" != *"/$selector/Dockerfile"* ]]; then
    fail "$selector must build from the repository root with its explicit Dockerfile"
  fi
}

assert_publish_root_build_context() {
  local selector="$1"
  local output
  output="$(node -e '
    const manifest = require(process.argv[1]);
    const selector = process.argv[2];
    const image = manifest.images.find(candidate => candidate.name === selector);
    if (!image) process.exit(2);
    process.stdout.write(image.rooted === true ? "rooted" : "service");
  ' "$REPO_ROOT/deploy/images.json" "$selector")"
  if [[ "$output" != "rooted" ]]; then
    fail "$selector publish must use the repository-root Docker build context"
  fi
}

# Direct consumers.  The first four are Node services; profile-ui and
# control-ui are Next.js consumers and therefore also require materialization.
assert_copy_before_every_ci control-api/Dockerfile \
  display-field grok-provider-attempt-contract image-policy llm-provider-attempt-contract \
  llm-providers workflow-recipe-capability-policy workflow-runtime-core
assert_copy_before_every_ci control-ui/Dockerfile \
  display-field frontend-components gfs-interaction-policy llm-providers workflow-recipe-capability-policy
assert_copy_before_every_ci profile-ui/Dockerfile desktop-app-links frontend-components
assert_copy_before_every_ci host-context-controller/Dockerfile \
  image-policy llm-providers network-policy-core workflow-recipe-capability-policy
assert_copy_before_every_ci mcp-host/Dockerfile \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.desktop \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.full \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.slim \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers

# Discover the expected local-package image artifacts independently from real
# package manifests, Dockerfiles, and executable local build targets. The
# manifest and Build & Publish matrix remain publication declarations whose
# exact parity is checked separately; neither declaration is a liveness oracle.
assert_independent_workspace_image_population
assert_manifest_matches_build_publish_matrix
assert_manifest_declared_local_packages
assert_manifest_source_mutations_rejected
assert_root_build_context rpc-proxy
assert_publish_root_build_context rpc-proxy

# workflow-runtime-core is built in a separate stage before workflow-recipes;
# these are the packages needed by that stage, while the application install
# also needs the recipe and image policy packages in its final stage.
assert_copy_before_every_ci workflow-recipes/Dockerfile \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers \
  network-policy-core workflow-runtime-core
assert_copy_before_every_ci workflow-recipes/Dockerfile.coordinator \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers \
  network-policy-core workflow-runtime-core
assert_copy_before_last_ci workflow-recipes/Dockerfile workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile image-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator image-policy

assert_materialized control-ui/Dockerfile display-field
assert_materialized control-ui/Dockerfile frontend-components
assert_materialized control-ui/Dockerfile gfs-interaction-policy
assert_materialized control-ui/Dockerfile llm-providers
assert_materialized control-ui/Dockerfile workflow-recipe-capability-policy
assert_materialized profile-ui/Dockerfile desktop-app-links
assert_materialized profile-ui/Dockerfile frontend-components

assert_dockerignore_allows control-api/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-api/Dockerfile.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows control-api/Dockerfile.dockerignore llm-provider-attempt-contract
assert_dockerignore_allows control-api/Dockerfile.dockerignore llm-providers
assert_dockerignore_allows workflow-recipes/Dockerfile.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows workflow-recipes/Dockerfile.coordinator.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows control-ui/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-ui/Dockerfile.dockerignore gfs-interaction-policy
assert_dockerignore_allows control-ui/Dockerfile.dockerignore llm-providers
assert_dockerignore_excludes_generated_dependencies \
  control-ui/Dockerfile.dockerignore gfs-interaction-policy
assert_dockerignore_narrow_package control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_excludes_generated_dependencies \
  control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_mutations_rejected

if (( failures > 0 )); then
  echo "$failures Docker local-package contract failure(s)" >&2
  exit 1
fi

echo "PASS: Docker local-package COPY/npm ci/materialization contract"
