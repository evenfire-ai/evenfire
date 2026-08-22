#!/usr/bin/env python3
"""Discover effective Deployment env bindings to one ConfigMap key.

The DeploymentList is read from stdin. Each binding is emitted as one record
whose fields are separated by ASCII unit separator (0x1f): namespace,
Deployment, desired replicas, exact label selector, container, and effective
environment-variable name. Kubernetes names and label selectors cannot
contain that delimiter, so the shell caller can preserve empty fields without
inventing an escaping convention.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


FIELD_SEPARATOR = "\x1f"


class ConsumerContractError(ValueError):
    """Raised when an active consumer cannot be described safely."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-map", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--namespace", required=True)
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


def references_target(env: dict[str, Any], config_map: str, key: str) -> bool:
    value_from = mapping(env.get("valueFrom"), "env.valueFrom")
    key_ref = mapping(value_from.get("configMapKeyRef"), "env.valueFrom.configMapKeyRef")
    return key_ref.get("name") == config_map and key_ref.get("key") == key


def effective_bindings(
    container: dict[str, Any], config_map: str, key: str
) -> list[tuple[str, str]]:
    container_name = text(container.get("name"), "container.name")
    env = sequence(container.get("env"), f"container {container_name}.env")
    env_from = sequence(container.get("envFrom"), f"container {container_name}.envFrom")

    # Explicit env entries override values imported through envFrom. Keep the
    # last definition for defensive parity with the runtime environment build;
    # valid Kubernetes templates normally de-duplicate this merge-keyed list.
    explicit_by_name: dict[str, dict[str, Any]] = {}
    for index, raw_env in enumerate(env):
        explicit = mapping(raw_env, f"container {container_name}.env[{index}]")
        env_name = text(explicit.get("name"), f"container {container_name}.env[{index}].name")
        explicit_by_name[env_name] = explicit

    names: set[str] = set()
    for index, raw_source in enumerate(env_from):
        source = mapping(raw_source, f"container {container_name}.envFrom[{index}]")
        config_ref = mapping(
            source.get("configMapRef"),
            f"container {container_name}.envFrom[{index}].configMapRef",
        )
        if config_ref.get("name") != config_map:
            continue
        prefix = text(
            source.get("prefix", ""),
            f"container {container_name}.envFrom[{index}].prefix",
            allow_empty=True,
        )
        effective_name = prefix + key
        override = explicit_by_name.get(effective_name)
        if override is None or references_target(override, config_map, key):
            names.add(effective_name)

    for env_name, explicit in explicit_by_name.items():
        if references_target(explicit, config_map, key):
            names.add(env_name)

    return [(container_name, env_name) for env_name in sorted(names)]


def render_selector(deployment: dict[str, Any]) -> str:
    spec = mapping(deployment.get("spec"), "deployment.spec")
    selector = mapping(spec.get("selector"), "deployment.spec.selector")
    match_labels = mapping(selector.get("matchLabels"), "deployment.spec.selector.matchLabels")
    match_expressions = sequence(
        selector.get("matchExpressions"), "deployment.spec.selector.matchExpressions"
    )
    terms: list[str] = []
    for raw_key in sorted(match_labels):
        key = text(raw_key, "deployment selector label key")
        value = text(match_labels[raw_key], f"deployment selector label {key}", allow_empty=True)
        terms.append(f"{key}={value}")

    for index, raw_expression in enumerate(match_expressions):
        expression = mapping(raw_expression, f"deployment selector expression[{index}]")
        key = text(expression.get("key"), f"deployment selector expression[{index}].key")
        operator = expression.get("operator")
        values = [
            text(value, f"deployment selector expression[{index}].values")
            for value in sequence(
                expression.get("values"), f"deployment selector expression[{index}].values"
            )
        ]
        if operator == "In" and values:
            terms.append(f"{key} in ({','.join(values)})")
        elif operator == "NotIn" and values:
            terms.append(f"{key} notin ({','.join(values)})")
        elif operator == "Exists" and not values:
            terms.append(key)
        elif operator == "DoesNotExist" and not values:
            terms.append(f"!{key}")
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


def records(payload: dict[str, Any], args: argparse.Namespace) -> list[tuple[str, ...]]:
    items = sequence(payload.get("items"), "DeploymentList.items")
    discovered: list[tuple[str, ...]] = []
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
        containers = sequence(
            pod_spec.get("containers"),
            f"deployment {namespace}/{name}.spec.template.spec.containers",
        )
        bindings: list[tuple[str, str]] = []
        for raw_container in containers:
            container = mapping(raw_container, f"deployment {namespace}/{name} container")
            bindings.extend(effective_bindings(container, args.config_map, args.key))
        bindings = sorted(set(bindings))
        if not bindings:
            continue

        replicas = desired_replicas(deployment)
        # A scaled-to-zero consumer has no active process to select or prove.
        # Do not let a selector shape block ConfigMap convergence for its next pod.
        selector = "" if replicas == 0 else render_selector(deployment)
        for container_name, env_name in bindings:
            discovered.append(
                (namespace, name, str(replicas), selector, container_name, env_name)
            )
    return sorted(discovered)


def main() -> int:
    args = parse_args()
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ConsumerContractError("DeploymentList is not an object")
        for record in records(payload, args):
            print(FIELD_SEPARATOR.join(record))
    except (ConsumerContractError, json.JSONDecodeError) as error:
        print(f"cannot discover ConfigMap key consumers: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
