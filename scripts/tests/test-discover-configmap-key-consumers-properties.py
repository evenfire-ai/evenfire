#!/usr/bin/env python3
"""Deterministic property coverage for ConfigMap consumer binding discovery.

R1-M4: exercise the real pure resolver over finite generated domains instead
of restating the shell harness examples.  The cases cover kubelet-style
environment precedence, provenance, expansion, missing-object behavior, and
stable snapshot serialization without a cluster or third-party dependency.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch
from typing import Any


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "minikube" / "discover-configmap-key-consumers.py"
SPEC = importlib.util.spec_from_file_location("discover_configmap_key_consumers", HELPER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load resolver from {HELPER}")
resolver = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = resolver
SPEC.loader.exec_module(resolver)


NAMESPACE = "mcp-host"
TARGET_CONFIG_MAP = "mcp-host-config"
TARGET_KEY = "CLERUM_AUTH_JWT_PUBLIC_KEY"
OTHER_CONFIG_MAP = "other-config"
OTHER_SECRET = "other-secret"
MISSING_CONFIG_MAP = "missing-config"
OTHER_KEY = "UNRELATED_KEY"


def resolver_args() -> argparse.Namespace:
    return argparse.Namespace(
        namespace=NAMESPACE,
        config_map=TARGET_CONFIG_MAP,
        key=TARGET_KEY,
    )


def object_entry(
    kind: str,
    name: str,
    *,
    present: bool = True,
    keys: tuple[str, ...] = (),
    resource_version: str = "1",
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "kind": kind,
        "namespace": NAMESPACE,
        "name": name,
        "present": present,
        "keys": list(keys),
    }
    if present:
        entry["uid"] = f"uid-{kind.lower()}-{name}"
        entry["resourceVersion"] = resource_version
    return entry


def inventory(*entries: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(entry["kind"], entry["name"]): copy.deepcopy(entry) for entry in entries}


def env_from(
    kind: str,
    name: str,
    *,
    prefix: str = "",
    optional: bool = False,
) -> dict[str, Any]:
    ref_field = "configMapRef" if kind == "ConfigMap" else "secretRef"
    return {"prefix": prefix, ref_field: {"name": name, "optional": optional}}


def key_env(
    env_name: str,
    kind: str,
    object_name: str,
    key: str,
    *,
    optional: bool = False,
) -> dict[str, Any]:
    ref_field = "configMapKeyRef" if kind == "ConfigMap" else "secretKeyRef"
    return {
        "name": env_name,
        "valueFrom": {
            ref_field: {"name": object_name, "key": key, "optional": optional}
        },
    }


def deployment(name: str, containers: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": NAMESPACE,
            "uid": f"uid-deployment-{name}",
            "resourceVersion": "ignored-by-snapshot",
        },
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name}},
                "spec": {"containers": containers},
            },
        },
    }


def parse_inventory(entries: list[dict[str, Any]], **json_kwargs: Any):
    raw = json.dumps(entries, **json_kwargs)
    with patch.dict(os.environ, {"CONSUMER_OBJECT_INVENTORY": raw}):
        return resolver.parse_inventory(NAMESPACE)


class ConfigMapConsumerResolverProperties(unittest.TestCase):
    def test_env_from_prefix_and_provenance_domain(self) -> None:
        """P1: only Kubernetes-valid effective env names preserve provenance."""

        prefix_domain = (
            ("", TARGET_KEY),
            ("AUTH_", f"AUTH_{TARGET_KEY}"),
            ("_", f"_{TARGET_KEY}"),
            ("-", f"-{TARGET_KEY}"),
            (".", f".{TARGET_KEY}"),
            ("bad-", f"bad-{TARGET_KEY}"),
            ("dot.", f"dot.{TARGET_KEY}"),
            ("9", None),
            ("..", None),
        )
        source_domain = tuple(
            itertools.product(
                ("ConfigMap", "Secret"),
                (TARGET_CONFIG_MAP, OTHER_CONFIG_MAP),
                (False, True),
            )
        )

        for (prefix, effective_name), (kind, name, target_key_present) in itertools.product(
            prefix_domain, source_domain
        ):
            with self.subTest(
                prefix=prefix,
                kind=kind,
                name=name,
                target_key_present=target_key_present,
            ):
                keys = (TARGET_KEY,) if target_key_present else (OTHER_KEY,)
                source_inventory = inventory(object_entry(kind, name, keys=keys))
                container = {
                    "name": "runtime",
                    "envFrom": [env_from(kind, name, prefix=prefix)],
                }
                expected = []
                if (
                    kind == "ConfigMap"
                    and name == TARGET_CONFIG_MAP
                    and target_key_present
                    and effective_name is not None
                ):
                    expected = [("runtime", effective_name)]
                self.assertEqual(
                    resolver.effective_bindings(
                        container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                    ),
                    expected,
                )

    def test_env_from_and_explicit_precedence_domain(self) -> None:
        """P2: later envFrom wins; explicit env then applies kubelet precedence."""

        source_inventory = inventory(
            object_entry("ConfigMap", TARGET_CONFIG_MAP, keys=(TARGET_KEY,)),
            object_entry("ConfigMap", OTHER_CONFIG_MAP, keys=(TARGET_KEY,)),
            object_entry("ConfigMap", MISSING_CONFIG_MAP, present=False),
        )
        source = {
            "target": env_from("ConfigMap", TARGET_CONFIG_MAP),
            "other": env_from("ConfigMap", OTHER_CONFIG_MAP),
        }
        chains = [(name,) for name in source]
        chains.extend(itertools.product(source, repeat=2))
        actions: dict[str, dict[str, Any] | None] = {
            "absent": None,
            "literal": {"name": TARGET_KEY, "value": "literal"},
            "target-ref": key_env(
                TARGET_KEY, "ConfigMap", TARGET_CONFIG_MAP, TARGET_KEY
            ),
            "other-ref": key_env(TARGET_KEY, "ConfigMap", OTHER_CONFIG_MAP, TARGET_KEY),
            "optional-missing": key_env(
                TARGET_KEY,
                "ConfigMap",
                MISSING_CONFIG_MAP,
                TARGET_KEY,
                optional=True,
            ),
            "field-ref": {
                "name": TARGET_KEY,
                "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}},
            },
        }

        for chain, (action_name, action) in itertools.product(chains, actions.items()):
            with self.subTest(chain=chain, action=action_name):
                target_after_env_from = chain[-1] == "target"
                if action_name == "target-ref":
                    target_after_explicit = True
                elif action_name in ("literal", "other-ref", "field-ref"):
                    target_after_explicit = False
                else:
                    target_after_explicit = target_after_env_from
                container = {
                    "name": "runtime",
                    "envFrom": [source[name] for name in chain],
                    "env": [] if action is None else [action],
                }
                expected = [("runtime", TARGET_KEY)] if target_after_explicit else []
                self.assertEqual(
                    resolver.effective_bindings(
                        container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                    ),
                    expected,
                )

    def test_value_from_provenance_and_missing_reference_domain(self) -> None:
        """P3: provenance is exact; optional absence skips and required absence fails."""

        reference_domain = itertools.product(
            ("ConfigMap", "Secret"),
            (TARGET_CONFIG_MAP, OTHER_CONFIG_MAP),
            (TARGET_KEY, OTHER_KEY),
            ("absent-object", "missing-key", "present-key"),
            (False, True),
        )
        for kind, name, key, object_state, optional in reference_domain:
            with self.subTest(
                kind=kind,
                name=name,
                key=key,
                object_state=object_state,
                optional=optional,
            ):
                present = object_state != "absent-object"
                keys = (key,) if object_state == "present-key" else ()
                source_inventory = inventory(
                    object_entry(kind, name, present=present, keys=keys)
                )
                container = {
                    "name": "runtime",
                    "env": [key_env("PROBED", kind, name, key, optional=optional)],
                }
                missing = object_state != "present-key"
                if missing and not optional:
                    with self.assertRaises(resolver.ConsumerContractError):
                        resolver.effective_bindings(
                            container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                        )
                    continue
                expected = []
                if (
                    not missing
                    and kind == "ConfigMap"
                    and name == TARGET_CONFIG_MAP
                    and key == TARGET_KEY
                ):
                    expected = [("runtime", "PROBED")]
                self.assertEqual(
                    resolver.effective_bindings(
                        container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                    ),
                    expected,
                )

        complete_inventory = inventory(
            object_entry("ConfigMap", TARGET_CONFIG_MAP, keys=(TARGET_KEY,)),
            object_entry("ConfigMap", OTHER_CONFIG_MAP, keys=(TARGET_KEY,)),
        )
        value_from_domain: dict[str, dict[str, Any] | None] = {
            "none": None,
            "target": key_env(
                "PROBED", "ConfigMap", TARGET_CONFIG_MAP, TARGET_KEY
            )["valueFrom"],
            "other": key_env(
                "PROBED", "ConfigMap", OTHER_CONFIG_MAP, TARGET_KEY
            )["valueFrom"],
            "field": {"fieldRef": {"fieldPath": "metadata.name"}},
        }
        for value, (source_name, value_from) in itertools.product(
            ("", "literal"), value_from_domain.items()
        ):
            with self.subTest(value=value, value_from=source_name):
                explicit: dict[str, Any] = {"name": "PROBED", "value": value}
                if value_from is not None:
                    explicit["valueFrom"] = value_from
                expected = (
                    [("runtime", "PROBED")]
                    if not value and source_name == "target"
                    else []
                )
                self.assertEqual(
                    resolver.effective_bindings(
                        {"name": "runtime", "env": [explicit]},
                        TARGET_CONFIG_MAP,
                        TARGET_KEY,
                        complete_inventory,
                    ),
                    expected,
                )

        for kind, name, present, optional in itertools.product(
            ("ConfigMap", "Secret"),
            (TARGET_CONFIG_MAP, OTHER_CONFIG_MAP),
            (False, True),
            (False, True),
        ):
            with self.subTest(
                env_from_kind=kind,
                env_from_name=name,
                present=present,
                optional=optional,
            ):
                source_inventory = inventory(
                    object_entry(
                        kind,
                        name,
                        present=present,
                        keys=(TARGET_KEY,) if present else (),
                    )
                )
                container = {
                    "name": "runtime",
                    "envFrom": [env_from(kind, name, optional=optional)],
                }
                if not present and not optional:
                    with self.assertRaises(resolver.ConsumerContractError):
                        resolver.effective_bindings(
                            container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                        )
                    continue
                expected = (
                    [("runtime", TARGET_KEY)]
                    if present and kind == "ConfigMap" and name == TARGET_CONFIG_MAP
                    else []
                )
                self.assertEqual(
                    resolver.effective_bindings(
                        container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                    ),
                    expected,
                )

        optional_missing = {
            "name": "runtime",
            "envFrom": [
                env_from("ConfigMap", MISSING_CONFIG_MAP, optional=True)
            ],
        }
        with self.assertRaisesRegex(
            resolver.ConsumerContractError, "sanitized inventory omitted referenced ConfigMap"
        ):
            resolver.effective_bindings(
                optional_missing, TARGET_CONFIG_MAP, TARGET_KEY, {}
            )

    def test_expansion_domain_is_ordered_and_fail_closed(self) -> None:
        """P4: exact expansion copies provenance; escaped/composite forms do not guess."""

        source_inventory = inventory(
            object_entry("ConfigMap", TARGET_CONFIG_MAP, keys=(TARGET_KEY,)),
            object_entry("ConfigMap", OTHER_CONFIG_MAP, keys=(TARGET_KEY,)),
        )
        value_domain = (
            (f"$({TARGET_KEY})", "exact-target"),
            (f"$$({TARGET_KEY})", "escaped-target"),
            (f"prefix-$({TARGET_KEY})", "composite-target"),
            (f"$({TARGET_KEY})-suffix", "composite-target"),
            ("$(UNKNOWN)", "exact-other"),
            ("prefix-$(UNKNOWN)", "composite-other"),
            (f"$$({TARGET_KEY})-$(UNKNOWN)", "escaped-target"),
        )
        for base_provenance, (value, value_class) in itertools.product(
            ("target", "other"), value_domain
        ):
            with self.subTest(base=base_provenance, value=value):
                source_name = (
                    TARGET_CONFIG_MAP if base_provenance == "target" else OTHER_CONFIG_MAP
                )
                container = {
                    "name": "runtime",
                    "envFrom": [env_from("ConfigMap", source_name)],
                    "env": [{"name": "EXPANDED", "value": value}],
                }
                if base_provenance == "target" and value_class == "composite-target":
                    with self.assertRaisesRegex(
                        resolver.ConsumerContractError, "ambiguous composite expansion"
                    ):
                        resolver.effective_bindings(
                            container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                        )
                    continue
                expected = []
                if base_provenance == "target":
                    expected.append(("runtime", TARGET_KEY))
                    if value_class == "exact-target":
                        expected.append(("runtime", "EXPANDED"))
                self.assertEqual(
                    resolver.effective_bindings(
                        container, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
                    ),
                    expected,
                )

        backward = {
            "name": "runtime",
            "envFrom": [env_from("ConfigMap", TARGET_CONFIG_MAP)],
            "env": [
                {"name": "ALIAS_ONE", "value": f"$({TARGET_KEY})"},
                {"name": "ALIAS_TWO", "value": "$(ALIAS_ONE)"},
            ],
        }
        forward = copy.deepcopy(backward)
        forward["env"].reverse()
        self.assertEqual(
            resolver.effective_bindings(
                backward, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
            ),
            [
                ("runtime", "ALIAS_ONE"),
                ("runtime", "ALIAS_TWO"),
                ("runtime", TARGET_KEY),
            ],
        )
        self.assertEqual(
            resolver.effective_bindings(
                forward, TARGET_CONFIG_MAP, TARGET_KEY, source_inventory
            ),
            [("runtime", "ALIAS_ONE"), ("runtime", TARGET_KEY)],
        )

    def test_reference_requiredness_is_order_independent(self) -> None:
        """P5: repeated optional/required refs collapse to required if any is required."""

        args = resolver_args()
        for count in (1, 2, 3):
            for optional_flags in itertools.product((False, True), repeat=count):
                with self.subTest(optional_flags=optional_flags):
                    container = {
                        "name": "runtime",
                        "envFrom": [
                            env_from(
                                "ConfigMap",
                                TARGET_CONFIG_MAP,
                                optional=optional,
                            )
                            for optional in optional_flags
                        ],
                    }
                    payload = {"items": [deployment("runtime", [container])]}
                    references = resolver.referenced_objects(payload, args)
                    self.assertEqual(
                        references[("ConfigMap", TARGET_CONFIG_MAP)],
                        any(not optional for optional in optional_flags),
                    )

    def test_records_and_snapshot_are_serialization_deterministic(self) -> None:
        """P6: canonical output ignores input ordering but detects contract mutations."""

        args = resolver_args()
        deployments = [
            deployment(
                "z-host",
                [
                    {
                        "name": "host",
                        "envFrom": [
                            env_from("ConfigMap", TARGET_CONFIG_MAP),
                            env_from("Secret", OTHER_SECRET, prefix="SECRET_"),
                        ],
                        "env": [
                            {"name": "AUTH_ALIAS", "value": f"$({TARGET_KEY})"}
                        ],
                    }
                ],
            ),
            deployment(
                "a-wfc",
                [
                    {
                        "name": "wfc",
                        "env": [
                            key_env(
                                "WSF_JWT_PUBLIC_KEY",
                                "ConfigMap",
                                TARGET_CONFIG_MAP,
                                TARGET_KEY,
                            )
                        ],
                    }
                ],
            ),
        ]
        base_entries = [
            object_entry(
                "ConfigMap", TARGET_CONFIG_MAP, keys=(OTHER_KEY, TARGET_KEY)
            ),
            object_entry("Secret", OTHER_SECRET, keys=("PASSWORD", "USERNAME")),
        ]

        baseline: tuple[list[tuple[str, ...]], str] | None = None
        for reverse_deployments, reverse_entries, reverse_keys, pretty in itertools.product(
            (False, True), repeat=4
        ):
            with self.subTest(
                reverse_deployments=reverse_deployments,
                reverse_entries=reverse_entries,
                reverse_keys=reverse_keys,
                pretty=pretty,
            ):
                payload_items = copy.deepcopy(deployments)
                entries = copy.deepcopy(base_entries)
                if reverse_deployments:
                    payload_items.reverse()
                if reverse_entries:
                    entries.reverse()
                if reverse_keys:
                    for entry in entries:
                        entry["keys"].reverse()
                normalized = parse_inventory(
                    entries,
                    indent=2 if pretty else None,
                    sort_keys=not pretty,
                )
                result = resolver.resolve_records(
                    {"items": payload_items}, args, normalized
                )
                if baseline is None:
                    baseline = result
                self.assertEqual(result, baseline)

        assert baseline is not None
        records, snapshot_hash = baseline
        self.assertEqual(records, sorted(records))
        self.assertRegex(snapshot_hash, re.compile(r"^[0-9a-f]{64}$"))

        metadata_only = copy.deepcopy(deployments)
        metadata_only[0]["metadata"]["resourceVersion"] = "new-status-version"
        metadata_result = resolver.resolve_records(
            {"items": metadata_only}, args, parse_inventory(base_entries)
        )
        self.assertEqual(metadata_result, baseline)

        changed_uid = copy.deepcopy(deployments)
        changed_uid[0]["metadata"]["uid"] = "replacement-deployment-uid"
        _, changed_uid_hash = resolver.resolve_records(
            {"items": changed_uid}, args, parse_inventory(base_entries)
        )
        self.assertNotEqual(changed_uid_hash, snapshot_hash)

        changed_object = copy.deepcopy(base_entries)
        changed_object[0]["resourceVersion"] = "2"
        _, changed_object_hash = resolver.resolve_records(
            {"items": deployments}, args, parse_inventory(changed_object)
        )
        self.assertNotEqual(changed_object_hash, snapshot_hash)

        changed_binding = copy.deepcopy(deployments)
        changed_binding[0]["spec"]["template"]["spec"]["containers"][0]["env"].append(
            {"name": TARGET_KEY, "value": "shadowed"}
        )
        changed_records, changed_binding_hash = resolver.resolve_records(
            {"items": changed_binding}, args, parse_inventory(base_entries)
        )
        self.assertNotEqual(changed_records, records)
        self.assertNotEqual(changed_binding_hash, snapshot_hash)


if __name__ == "__main__":
    unittest.main(verbosity=2)
