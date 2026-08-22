#!/usr/bin/env python3
"""Discover effective Deployment env bindings to one ConfigMap key.

The helper is intentionally pure: Kubernetes JSON is read from stdin and a
sanitized object inventory is supplied by the shell caller. It never invokes
kubectl and never receives ConfigMap or Secret values.

Binding records use ASCII unit separator (0x1f): namespace, Deployment,
desired replicas, exact label selector, container, and effective environment
name. Resolve mode prefixes those rows with a snapshot hash record so the
caller can prove that pod templates and referenced key presence stayed stable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from typing import Any


FIELD_SEPARATOR = "\x1f"
TARGET = "TARGET"
OTHER = "OTHER"
LITERAL = "LITERAL"
EXACT_EXPANSION = re.compile(r"^\$\(([^)]+)\)$")
ANY_EXPANSION = re.compile(r"\$\(([^)]+)\)")


class ConsumerContractError(ValueError):
    """Raised when an active consumer cannot be described safely."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-map", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument(
        "--mode",
        choices=("resolve", "references", "sanitize-object"),
        default="resolve",
    )
    parser.add_argument("--object-kind", choices=("ConfigMap", "Secret"))
    parser.add_argument("--object-name")
    parser.add_argument("--required", choices=("true", "false"))
    return parser.parse_args()


def mapping(value: Any, field: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConsumerContractError(f"{field} is not an object")
    return value


def sequence(value: Any, field: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ConsumerContractError(f"{field} is not an array")
    return value


def text(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ConsumerContractError(f"{field} is not a valid string")
    if any(character in value for character in (FIELD_SEPARATOR, "\n", "\r")):
        raise ConsumerContractError(f"{field} contains an unsupported control character")
    return value


def boolean(value: Any, field: str, *, default: bool = False) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ConsumerContractError(f"{field} is not a boolean")
    return value


def env_from_reference(source: dict[str, Any], field: str) -> tuple[str, dict[str, Any]]:
    refs: list[tuple[str, dict[str, Any]]] = []
    if source.get("configMapRef") is not None:
        refs.append(("ConfigMap", mapping(source.get("configMapRef"), f"{field}.configMapRef")))
    if source.get("secretRef") is not None:
        refs.append(("Secret", mapping(source.get("secretRef"), f"{field}.secretRef")))
    if len(refs) != 1:
        raise ConsumerContractError(
            f"{field} must contain exactly one ConfigMap or Secret reference"
        )
    return refs[0]


def key_reference(value_from: dict[str, Any], field: str) -> tuple[str, dict[str, Any]] | None:
    refs: list[tuple[str, dict[str, Any]]] = []
    if value_from.get("configMapKeyRef") is not None:
        refs.append(
            (
                "ConfigMap",
                mapping(value_from.get("configMapKeyRef"), f"{field}.configMapKeyRef"),
            )
        )
    if value_from.get("secretKeyRef") is not None:
        refs.append(("Secret", mapping(value_from.get("secretKeyRef"), f"{field}.secretKeyRef")))
    if len(refs) > 1:
        raise ConsumerContractError(f"{field} contains competing key references")
    return refs[0] if refs else None


def explicit_key_reference(env: dict[str, Any], field: str) -> tuple[str, dict[str, Any]] | None:
    value = text(env.get("value", ""), f"{field}.value", allow_empty=True)
    if value or env.get("valueFrom") is None:
        return None
    return key_reference(mapping(env.get("valueFrom"), f"{field}.valueFrom"), f"{field}.valueFrom")


def container_references_target(
    container: dict[str, Any], config_map: str, key: str
) -> bool:
    container_name = text(container.get("name"), "container.name")
    for index, raw_source in enumerate(
        sequence(container.get("envFrom"), f"container {container_name}.envFrom")
    ):
        source = mapping(raw_source, f"container {container_name}.envFrom[{index}]")
        kind, ref = env_from_reference(source, f"container {container_name}.envFrom[{index}]")
        if kind == "ConfigMap" and ref.get("name") == config_map:
            return True

    for index, raw_env in enumerate(
        sequence(container.get("env"), f"container {container_name}.env")
    ):
        env = mapping(raw_env, f"container {container_name}.env[{index}]")
        ref = explicit_key_reference(env, f"container {container_name}.env[{index}]")
        if ref is None:
            continue
        kind, key_ref = ref
        if kind == "ConfigMap" and key_ref.get("name") == config_map and key_ref.get("key") == key:
            return True
    return False


def container_object_references(container: dict[str, Any]) -> dict[tuple[str, str], bool]:
    container_name = text(container.get("name"), "container.name")
    references: dict[tuple[str, str], bool] = {}
    for index, raw_source in enumerate(
        sequence(container.get("envFrom"), f"container {container_name}.envFrom")
    ):
        field = f"container {container_name}.envFrom[{index}]"
        source = mapping(raw_source, field)
        kind, ref = env_from_reference(source, field)
        name = text(ref.get("name"), f"{field}.name")
        required = not boolean(ref.get("optional"), f"{field}.optional")
        references[(kind, name)] = references.get((kind, name), False) or required

    for index, raw_env in enumerate(
        sequence(container.get("env"), f"container {container_name}.env")
    ):
        field = f"container {container_name}.env[{index}]"
        env = mapping(raw_env, field)
        ref = explicit_key_reference(env, field)
        if ref is None:
            continue
        kind, key_ref = ref
        name = text(key_ref.get("name"), f"{field}.valueFrom.name")
        text(key_ref.get("key"), f"{field}.valueFrom.key")
        required = not boolean(key_ref.get("optional"), f"{field}.valueFrom.optional")
        references[(kind, name)] = references.get((kind, name), False) or required
    return references


def candidate_containers(payload: dict[str, Any], args: argparse.Namespace):
    items = sequence(payload.get("items"), "DeploymentList.items")
    for index, raw_deployment in enumerate(items):
        deployment = mapping(raw_deployment, f"DeploymentList.items[{index}]")
        metadata = mapping(deployment.get("metadata"), "deployment.metadata")
        name = text(metadata.get("name"), "deployment.metadata.name")
        namespace = text(metadata.get("namespace", args.namespace), "deployment.metadata.namespace")
        if namespace != args.namespace:
            raise ConsumerContractError(
                f"deployment {namespace}/{name} escaped namespace-scoped discovery"
            )
        spec = mapping(deployment.get("spec"), f"deployment {namespace}/{name}.spec")
        template = mapping(spec.get("template"), f"deployment {namespace}/{name}.spec.template")
        pod_spec = mapping(
            template.get("spec"), f"deployment {namespace}/{name}.spec.template.spec"
        )
        for raw_container in sequence(
            pod_spec.get("containers"),
            f"deployment {namespace}/{name}.spec.template.spec.containers",
        ):
            container = mapping(raw_container, f"deployment {namespace}/{name} container")
            if container_references_target(container, args.config_map, args.key):
                yield deployment, container


def referenced_objects(
    payload: dict[str, Any], args: argparse.Namespace
) -> dict[tuple[str, str], bool]:
    references: dict[tuple[str, str], bool] = {}
    for _deployment, container in candidate_containers(payload, args):
        for identity, required in container_object_references(container).items():
            references[identity] = references.get(identity, False) or required
    return references


def parse_inventory(namespace: str) -> dict[tuple[str, str], dict[str, Any]]:
    raw = os.environ.get("CONSUMER_OBJECT_INVENTORY")
    if raw is None:
        raise ConsumerContractError("sanitized referenced-object inventory was not provided")
    try:
        decoded = json.loads(raw)
        entries = decoded if isinstance(decoded, list) else [decoded]
    except json.JSONDecodeError:
        try:
            entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
        except json.JSONDecodeError as error:
            raise ConsumerContractError(
                f"referenced-object inventory is invalid JSON: {error}"
            ) from error

    inventory: dict[tuple[str, str], dict[str, Any]] = {}
    for index, raw_entry in enumerate(entries):
        entry = mapping(raw_entry, f"referenced-object inventory[{index}]")
        kind = text(entry.get("kind"), f"referenced-object inventory[{index}].kind")
        if kind not in ("ConfigMap", "Secret"):
            raise ConsumerContractError(f"referenced-object inventory[{index}].kind is unsupported")
        entry_namespace = text(
            entry.get("namespace"), f"referenced-object inventory[{index}].namespace"
        )
        if entry_namespace != namespace:
            raise ConsumerContractError(
                f"referenced object {entry_namespace}/{entry.get('name')} escaped "
                "namespace-scoped discovery"
            )
        name = text(entry.get("name"), f"referenced-object inventory[{index}].name")
        present = boolean(entry.get("present"), f"referenced-object inventory[{index}].present")
        keys = sorted(
            {
                text(key, f"referenced-object inventory[{index}].keys")
                for key in sequence(entry.get("keys"), f"referenced-object inventory[{index}].keys")
            }
        )
        normalized: dict[str, Any] = {
            "kind": kind,
            "namespace": entry_namespace,
            "name": name,
            "present": present,
            "keys": keys,
        }
        if present:
            normalized["uid"] = text(
                entry.get("uid"), f"referenced-object inventory[{index}].uid"
            )
            normalized["resourceVersion"] = text(
                entry.get("resourceVersion"),
                f"referenced-object inventory[{index}].resourceVersion",
            )
        elif keys:
            raise ConsumerContractError(
                f"absent referenced-object inventory[{index}] unexpectedly contains keys"
            )
        identity = (kind, name)
        if identity in inventory:
            raise ConsumerContractError(f"referenced-object inventory duplicates {kind} {name}")
        inventory[identity] = normalized
    return inventory


def inventory_object(
    inventory: dict[tuple[str, str], dict[str, Any]],
    kind: str,
    ref: dict[str, Any],
    field: str,
) -> dict[str, Any] | None:
    name = text(ref.get("name"), f"{field}.name")
    optional = boolean(ref.get("optional"), f"{field}.optional")
    obj = inventory.get((kind, name))
    if obj is None:
        raise ConsumerContractError(f"sanitized inventory omitted referenced {kind} {name}")
    if not obj["present"]:
        if optional:
            return None
        raise ConsumerContractError(f"required referenced {kind} {name} is absent")
    return obj


def effective_bindings(
    container: dict[str, Any],
    config_map: str,
    key: str,
    inventory: dict[tuple[str, str], dict[str, Any]],
) -> list[tuple[str, str]]:
    container_name = text(container.get("name"), "container.name")
    state: dict[str, str] = {}

    for index, raw_source in enumerate(
        sequence(container.get("envFrom"), f"container {container_name}.envFrom")
    ):
        field = f"container {container_name}.envFrom[{index}]"
        source = mapping(raw_source, field)
        kind, ref = env_from_reference(source, field)
        obj = inventory_object(inventory, kind, ref, field)
        if obj is None:
            continue
        prefix = text(source.get("prefix", ""), f"{field}.prefix", allow_empty=True)
        ref_name = text(ref.get("name"), f"{field}.name")
        for raw_key in obj["keys"]:
            effective_name = text(prefix + raw_key, f"{field} effective environment name")
            state[effective_name] = (
                TARGET
                if kind == "ConfigMap" and ref_name == config_map and raw_key == key
                else OTHER
            )

    for index, raw_env in enumerate(
        sequence(container.get("env"), f"container {container_name}.env")
    ):
        field = f"container {container_name}.env[{index}]"
        env = mapping(raw_env, field)
        env_name = text(env.get("name"), f"{field}.name")
        value = text(env.get("value", ""), f"{field}.value", allow_empty=True)
        if value:
            exact = EXACT_EXPANSION.fullmatch(value)
            if exact:
                source_name = text(exact.group(1), f"{field}.value expansion")
                state[env_name] = state.get(source_name, LITERAL)
                continue
            dependencies = ANY_EXPANSION.findall(value)
            if any(state.get(dependency) == TARGET for dependency in dependencies):
                raise ConsumerContractError(
                    f"{field}.value has an ambiguous composite expansion of the target key"
                )
            state[env_name] = LITERAL
            continue

        if env.get("valueFrom") is None:
            state[env_name] = LITERAL
            continue
        value_from = mapping(env.get("valueFrom"), f"{field}.valueFrom")
        ref = key_reference(value_from, f"{field}.valueFrom")
        if ref is None:
            if (
                value_from.get("fieldRef") is not None
                or value_from.get("resourceFieldRef") is not None
            ):
                state[env_name] = OTHER
                continue
            raise ConsumerContractError(f"{field}.valueFrom has no supported runtime source")
        kind, key_ref = ref
        obj = inventory_object(inventory, kind, key_ref, f"{field}.valueFrom")
        raw_key = text(key_ref.get("key"), f"{field}.valueFrom.key")
        if obj is None or raw_key not in obj["keys"]:
            if boolean(key_ref.get("optional"), f"{field}.valueFrom.optional"):
                continue
            ref_name = text(key_ref.get("name"), f"{field}.valueFrom.name")
            raise ConsumerContractError(
                f"required key {raw_key} is absent from referenced {kind} {ref_name}"
            )
        ref_name = text(key_ref.get("name"), f"{field}.valueFrom.name")
        state[env_name] = (
            TARGET
            if kind == "ConfigMap" and ref_name == config_map and raw_key == key
            else OTHER
        )

    return [
        (container_name, env_name)
        for env_name, provenance in sorted(state.items())
        if provenance == TARGET
    ]


def render_selector(deployment: dict[str, Any]) -> str:
    spec = mapping(deployment.get("spec"), "deployment.spec")
    selector = mapping(spec.get("selector"), "deployment.spec.selector")
    match_labels = mapping(selector.get("matchLabels"), "deployment.spec.selector.matchLabels")
    match_expressions = sequence(
        selector.get("matchExpressions"), "deployment.spec.selector.matchExpressions"
    )
    terms: list[str] = []
    for raw_key in sorted(match_labels):
        label_key = text(raw_key, "deployment selector label key")
        value = text(
            match_labels[raw_key], f"deployment selector label {label_key}", allow_empty=True
        )
        terms.append(f"{label_key}={value}")

    for index, raw_expression in enumerate(match_expressions):
        expression = mapping(raw_expression, f"deployment selector expression[{index}]")
        label_key = text(
            expression.get("key"), f"deployment selector expression[{index}].key"
        )
        operator = expression.get("operator")
        values = [
            text(
                value,
                f"deployment selector expression[{index}].values",
                allow_empty=True,
            )
            for value in sequence(
                expression.get("values"), f"deployment selector expression[{index}].values"
            )
        ]
        if operator == "In" and values:
            terms.append(f"{label_key} in ({','.join(values)})")
        elif operator == "NotIn" and values:
            terms.append(f"{label_key} notin ({','.join(values)})")
        elif operator == "Exists" and not values:
            terms.append(label_key)
        elif operator == "DoesNotExist" and not values:
            terms.append(f"!{label_key}")
        else:
            raise ConsumerContractError(
                f"deployment selector expression[{index}] has unsupported operator/value shape"
            )

    if not terms:
        raise ConsumerContractError("active consumer Deployment has no usable pod selector")
    return ",".join(terms)


def desired_replicas(deployment: dict[str, Any]) -> int:
    spec = mapping(deployment.get("spec"), "deployment.spec")
    replicas = spec.get("replicas", 1)
    if isinstance(replicas, bool) or not isinstance(replicas, int) or replicas < 0:
        raise ConsumerContractError("deployment.spec.replicas is not a non-negative integer")
    return replicas


def resolve_records(
    payload: dict[str, Any],
    args: argparse.Namespace,
    inventory: dict[tuple[str, str], dict[str, Any]],
) -> tuple[list[tuple[str, ...]], str]:
    items = sequence(payload.get("items"), "DeploymentList.items")
    discovered: list[tuple[str, ...]] = []
    deployment_snapshots: list[dict[str, Any]] = []
    reference_contract = referenced_objects(payload, args)

    for index, raw_deployment in enumerate(items):
        deployment = mapping(raw_deployment, f"DeploymentList.items[{index}]")
        metadata = mapping(deployment.get("metadata"), "deployment.metadata")
        name = text(metadata.get("name"), "deployment.metadata.name")
        namespace = text(
            metadata.get("namespace", args.namespace), "deployment.metadata.namespace"
        )
        if namespace != args.namespace:
            raise ConsumerContractError(
                f"deployment {namespace}/{name} escaped namespace-scoped discovery"
            )
        spec = mapping(deployment.get("spec"), f"deployment {namespace}/{name}.spec")
        template = mapping(spec.get("template"), f"deployment {namespace}/{name}.spec.template")
        pod_spec = mapping(
            template.get("spec"), f"deployment {namespace}/{name}.spec.template.spec"
        )
        candidate_contracts: list[dict[str, Any]] = []
        bindings: list[tuple[str, str]] = []
        for raw_container in sequence(
            pod_spec.get("containers"),
            f"deployment {namespace}/{name}.spec.template.spec.containers",
        ):
            container = mapping(raw_container, f"deployment {namespace}/{name} container")
            if not container_references_target(container, args.config_map, args.key):
                continue
            container_name = text(container.get("name"), "container.name")
            env_from = sequence(container.get("envFrom"), f"container {container_name}.envFrom")
            env = sequence(container.get("env"), f"container {container_name}.env")
            candidate_contracts.append(
                {"name": container_name, "envFrom": env_from, "env": env}
            )
            bindings.extend(
                effective_bindings(container, args.config_map, args.key, inventory)
            )
        if not candidate_contracts:
            continue

        bindings = sorted(set(bindings))
        replicas = desired_replicas(deployment)
        selector = "" if replicas == 0 or not bindings else render_selector(deployment)
        # A legitimate rollout and its status updates change Deployment
        # resourceVersion. Hash only the immutable identity and normalized
        # binding contract so that the expected rollout is not mistaken for
        # concurrent contract drift.
        deployment_snapshots.append(
            {
                "namespace": namespace,
                "name": name,
                "uid": text(metadata.get("uid"), f"deployment {namespace}/{name}.metadata.uid"),
                "replicas": replicas,
                "selector": selector,
                "containers": candidate_contracts,
                "bindings": bindings,
            }
        )
        for container_name, env_name in bindings:
            discovered.append(
                (namespace, name, str(replicas), selector, container_name, env_name)
            )

    inventory_snapshot = []
    for kind, name in sorted(reference_contract):
        obj = inventory.get((kind, name))
        if obj is None:
            raise ConsumerContractError(f"sanitized inventory omitted referenced {kind} {name}")
        inventory_snapshot.append(obj)
    canonical = json.dumps(
        {
            "deployments": sorted(
                deployment_snapshots, key=lambda item: (item["namespace"], item["name"])
            ),
            "inventory": inventory_snapshot,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sorted(discovered), hashlib.sha256(canonical).hexdigest()


def sanitize_object(args: argparse.Namespace) -> None:
    if args.object_kind is None or args.object_name is None or args.required is None:
        raise ConsumerContractError(
            "sanitize-object mode requires --object-kind, --object-name and --required"
        )
    name = text(args.object_name, "referenced object name")
    required = args.required == "true"
    raw = sys.stdin.read()
    if not raw.strip():
        if required:
            raise ConsumerContractError(
                f"required referenced {args.object_kind} {name} is absent"
            )
        print(
            json.dumps(
                {
                    "kind": args.object_kind,
                    "namespace": args.namespace,
                    "name": name,
                    "present": False,
                    "keys": [],
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return

    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ConsumerContractError("referenced Kubernetes object is not an object")
    actual_kind = obj.get("kind", args.object_kind)
    if actual_kind != args.object_kind:
        raise ConsumerContractError(
            f"referenced object kind {actual_kind} did not match {args.object_kind}"
        )
    metadata = mapping(obj.get("metadata"), "referenced object metadata")
    actual_name = text(metadata.get("name"), "referenced object metadata.name")
    namespace = text(
        metadata.get("namespace", args.namespace), "referenced object metadata.namespace"
    )
    if actual_name != name or namespace != args.namespace:
        raise ConsumerContractError(
            f"referenced object identity {namespace}/{actual_name} did not match "
            f"{args.namespace}/{name}"
        )
    data = mapping(obj.get("data"), "referenced object data")
    normalized = {
        "kind": args.object_kind,
        "namespace": namespace,
        "name": name,
        "present": True,
        "uid": text(metadata.get("uid"), "referenced object metadata.uid"),
        "resourceVersion": text(
            metadata.get("resourceVersion"), "referenced object metadata.resourceVersion"
        ),
        "keys": sorted(text(key, "referenced object data key") for key in data),
    }
    print(json.dumps(normalized, sort_keys=True, separators=(",", ":")))


def load_payload() -> dict[str, Any]:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ConsumerContractError("DeploymentList is not an object")
    return payload


def main() -> int:
    args = parse_args()
    try:
        if args.mode == "sanitize-object":
            sanitize_object(args)
            return 0

        payload = load_payload()
        if args.mode == "references":
            for (kind, name), required in sorted(referenced_objects(payload, args).items()):
                print(FIELD_SEPARATOR.join((kind, name, "true" if required else "false")))
            return 0

        inventory = parse_inventory(args.namespace)
        records, snapshot_hash = resolve_records(payload, args, inventory)
        print(FIELD_SEPARATOR.join(("@snapshot", snapshot_hash)))
        for record in records:
            print(FIELD_SEPARATOR.join(record))
    except (ConsumerContractError, json.JSONDecodeError) as error:
        print(f"cannot discover ConfigMap key consumers: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
