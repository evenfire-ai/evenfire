#!/usr/bin/env python3
"""Validate observations for the WRC shell journey using only the standard library."""

import datetime
import ipaddress
import json
import re
import sys


def deletion_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value
    ):
        return False
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def metadata(document, expected_uid=None):
    value = json.loads(document)["metadata"]
    if not isinstance(value, dict):
        raise ValueError("invalid metadata")
    if not isinstance(value.get("uid"), str) or not value["uid"]:
        raise ValueError("missing UID")
    if not isinstance(value.get("resourceVersion"), str) or not value["resourceVersion"]:
        raise ValueError("missing resourceVersion")
    if expected_uid is not None and value["uid"] != expected_uid:
        raise ValueError("object UID changed")
    finalizers = value.get("finalizers", [])
    if not isinstance(finalizers, list) or not all(isinstance(f, str) for f in finalizers):
        raise ValueError("invalid finalizers")
    return value


def finalizer_patch(mode, expected_uid, document, hold):
    meta = metadata(document, expected_uid)
    finalizers = meta.get("finalizers", [])
    if mode == "install":
        if meta.get("deletionTimestamp") is not None or hold in finalizers:
            raise ValueError("barrier already installed or object deleting")
        finalizers = [*finalizers, hold]
    elif mode == "release":
        if finalizers.count(hold) != 1:
            raise ValueError("owned barrier missing or duplicated")
        finalizers = [f for f in finalizers if f != hold]
    else:
        raise ValueError("invalid barrier operation")
    return [
        {"op": "test", "path": "/metadata/uid", "value": meta["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": meta["resourceVersion"]},
        {"op": "add", "path": "/metadata/finalizers", "value": finalizers},
    ]


def barrier_ready(policy_uid, recipe_uid, policy, recipe, hold):
    child = metadata(policy, policy_uid)
    parent = metadata(recipe, recipe_uid)
    if hold not in child.get("finalizers", []):
        raise ValueError("child barrier disappeared")
    if "clerum.io/workload-cleanup" not in parent.get("finalizers", []):
        raise ValueError("parent cleanup finalizer disappeared")
    return deletion_timestamp(child.get("deletionTimestamp")) and deletion_timestamp(
        parent.get("deletionTimestamp")
    )


def finalizer_failure_count(lines, recipe_name, since):
    if not deletion_timestamp(since):
        raise ValueError("invalid observation start")
    start = datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))
    message = f'[WR-K8s] Finalizer cleanup failed for "{recipe_name}":'
    count = 0
    for line in lines:
        timestamp, separator, payload = line.partition(" ")
        if not separator or not deletion_timestamp(timestamp):
            continue
        observed_at = datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if observed_at >= start and payload.startswith(message):
            count += 1
    return count


def main(argv):
    command, *args = argv
    if command == "timestamp":
        return 0 if deletion_timestamp(args[0]) else 1
    if command == "uid":
        print(metadata(args[0])["uid"])
    elif command == "barrier-patch":
        print(json.dumps(finalizer_patch(*args), separators=(",", ":")))
    elif command == "barrier-ready":
        return 0 if barrier_ready(*args) else 1
    elif command == "service-ip":
        address = ipaddress.ip_address(args[0])
        if not 1 <= int(args[1]) <= 65535:
            raise ValueError("invalid backend port")
        print(address)
    elif command == "finalizer-failure-count":
        print(finalizer_failure_count(sys.stdin, *args))
    else:
        raise ValueError("unknown evidence command")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, KeyError, TypeError, IndexError):
        # Do not echo API objects or parser exceptions into run logs.
        print("Invalid or changed Kubernetes observation", file=sys.stderr)
        sys.exit(2)
