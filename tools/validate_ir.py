#!/usr/bin/env python3
"""Zero-dependency structural and conservative semantic validation for WEA IR.

The structural validator implements the JSON Schema subset used by ``schemas/``.
The semantic layer deliberately fails closed for cache/security critical facts that
JSON Schema cannot express: typed graph wiring, bounded feedback loops, canonical
foreign keys, effect/permission coherence, dependency completeness, cache gates,
runtime graph deltas, and cross-contract references.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA_DIR = ROOT / "schemas"

SCHEMA_FILES = {
    "wea.graph/v1": "graph.schema.json",
    "wea.trace/v1": "trace.schema.json",
    "wea.workflow-template/v1": "workflow-template.schema.json",
    "wea.workflow-instance/v1": "workflow-instance.schema.json",
    "wea.artifact/v1": "artifact.schema.json",
    "wea.reuse-certificate/v1": "reuse-certificate.schema.json",
    "wea.contracts/v1": "contracts.schema.json",
}
SCHEMA_ALIASES = {
    "graph": "graph.schema.json",
    "trace": "trace.schema.json",
    "workflow-template": "workflow-template.schema.json",
    "workflow-instance": "workflow-instance.schema.json",
    "artifact": "artifact.schema.json",
    "reuse-certificate": "reuse-certificate.schema.json",
    "contracts": "contracts.schema.json",
    **{name: name for name in SCHEMA_FILES.values()},
}

# These gates are correctness/security predicates, not telemetry labels. A direct
# reuse decision is invalid unless every one is explicitly PASS.
REQUIRED_REUSE_GATES = {
    "schema",
    "integrity",
    "trust",
    "authority",
    "contract",
    "dependency",
    "freshness",
    "environment",
    "effect",
    "noninterference",
    "verifier",
    "risk",
}

# Critical extensions need a registered semantic handler. There are deliberately
# none in v1: an unknown critical extension must never be silently ignored.
SUPPORTED_CRITICAL_FIELDS: set[str] = set()

NETWORK_RANK = {"deny": 0, "pinned": 1, "live": 2}
DIRECT_CACHE_MODES = {"EXACT", "SEMANTIC"}
REUSE_CACHE_MODES = {"EXACT", "SEMANTIC", "ADAPT"}


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    message: str
    phase: str = "semantic"

    def __str__(self) -> str:
        return f"{self.phase}: {self.path}: {self.message}"


class IRValidationError(ValueError):
    """Raised by :func:`assert_valid_document` with all collected issues."""

    def __init__(self, issues: Sequence[ValidationIssue]):
        self.issues = list(issues)
        super().__init__("\n".join(str(issue) for issue in self.issues))


def _path(parent: str, token: str | int) -> str:
    if isinstance(token, int):
        return f"{parent}[{token}]"
    if not parent or parent == "$":
        return f"$.{token}"
    return f"{parent}.{token}"


def _json_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return not isinstance(left, bool) and not isinstance(right, bool) and left == right
    return type(left) is type(right) and left == right


def _json_key(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class StructuralValidator:
    """Small JSON Schema 2020-12 subset sufficient for this repository's schemas."""

    def __init__(self, schema: Mapping[str, Any]):
        self.root = schema

    def validate(self, instance: Any) -> list[ValidationIssue]:
        return self._validate(instance, self.root, "$")

    def _resolve_ref(self, reference: str) -> Mapping[str, Any] | bool:
        if not reference.startswith("#/"):
            raise ValueError(f"only local JSON Schema references are supported: {reference}")
        current: Any = self.root
        for raw in reference[2:].split("/"):
            token = raw.replace("~1", "/").replace("~0", "~")
            current = current[token]
        return current

    def _branch_valid(self, instance: Any, schema: Any, path: str) -> bool:
        return not self._validate(instance, schema, path)

    def _validate(self, instance: Any, schema: Any, path: str) -> list[ValidationIssue]:
        if schema is True:
            return []
        if schema is False:
            return [ValidationIssue(path, "boolean schema rejects the value", "schema")]
        if not isinstance(schema, Mapping):
            return [ValidationIssue(path, "invalid schema node", "schema")]

        if "$ref" in schema:
            return self._validate(instance, self._resolve_ref(schema["$ref"]), path)

        errors: list[ValidationIssue] = []

        if "allOf" in schema:
            for branch in schema["allOf"]:
                errors.extend(self._validate(instance, branch, path))
        if "anyOf" in schema and not any(
            self._branch_valid(instance, branch, path) for branch in schema["anyOf"]
        ):
            errors.append(ValidationIssue(path, "does not satisfy anyOf", "schema"))
        if "oneOf" in schema:
            matches = sum(self._branch_valid(instance, branch, path) for branch in schema["oneOf"])
            if matches != 1:
                errors.append(ValidationIssue(path, f"satisfies {matches} oneOf branches; expected exactly one", "schema"))
        if "not" in schema and self._branch_valid(instance, schema["not"], path):
            errors.append(ValidationIssue(path, "matches forbidden 'not' schema", "schema"))

        if "const" in schema and not _json_equal(instance, schema["const"]):
            errors.append(ValidationIssue(path, f"must equal {schema['const']!r}", "schema"))
        if "enum" in schema and not any(_json_equal(instance, option) for option in schema["enum"]):
            errors.append(ValidationIssue(path, f"must be one of {schema['enum']!r}", "schema"))

        expected = schema.get("type")
        if expected is not None:
            expected_types = [expected] if isinstance(expected, str) else list(expected)
            if not any(self._is_type(instance, name) for name in expected_types):
                errors.append(ValidationIssue(path, f"expected type {expected!r}, got {type(instance).__name__}", "schema"))
                return errors

        if isinstance(instance, Mapping):
            required = schema.get("required", [])
            for key in required:
                if key not in instance:
                    errors.append(ValidationIssue(_path(path, key), "required property is missing", "schema"))

            properties = schema.get("properties", {})
            for key, value in instance.items():
                child_path = _path(path, key)
                if key in properties:
                    errors.extend(self._validate(value, properties[key], child_path))
                else:
                    additional = schema.get("additionalProperties", True)
                    if additional is False:
                        errors.append(ValidationIssue(child_path, "additional property is not allowed", "schema"))
                    elif isinstance(additional, Mapping) or isinstance(additional, bool):
                        errors.extend(self._validate(value, additional, child_path))

            if len(instance) < schema.get("minProperties", 0):
                errors.append(ValidationIssue(path, "has too few properties", "schema"))
            if "maxProperties" in schema and len(instance) > schema["maxProperties"]:
                errors.append(ValidationIssue(path, "has too many properties", "schema"))

        if isinstance(instance, list):
            if len(instance) < schema.get("minItems", 0):
                errors.append(ValidationIssue(path, f"requires at least {schema['minItems']} items", "schema"))
            if "maxItems" in schema and len(instance) > schema["maxItems"]:
                errors.append(ValidationIssue(path, f"allows at most {schema['maxItems']} items", "schema"))
            if schema.get("uniqueItems"):
                seen: set[str] = set()
                for index, item in enumerate(instance):
                    key = _json_key(item)
                    if key in seen:
                        errors.append(ValidationIssue(_path(path, index), "duplicate item violates uniqueItems", "schema"))
                    seen.add(key)
            if "items" in schema:
                for index, item in enumerate(instance):
                    errors.extend(self._validate(item, schema["items"], _path(path, index)))

        if isinstance(instance, str):
            if len(instance) < schema.get("minLength", 0):
                errors.append(ValidationIssue(path, f"requires minimum length {schema['minLength']}", "schema"))
            if "maxLength" in schema and len(instance) > schema["maxLength"]:
                errors.append(ValidationIssue(path, f"exceeds maximum length {schema['maxLength']}", "schema"))
            if "pattern" in schema and re.search(schema["pattern"], instance) is None:
                errors.append(ValidationIssue(path, f"does not match pattern {schema['pattern']!r}", "schema"))
            if "format" in schema and not self._valid_format(instance, schema["format"]):
                errors.append(ValidationIssue(path, f"invalid {schema['format']} format", "schema"))

        if isinstance(instance, (int, float)) and not isinstance(instance, bool):
            if isinstance(instance, float) and not math.isfinite(instance):
                errors.append(ValidationIssue(path, "JSON number must be finite", "schema"))
            if "minimum" in schema and instance < schema["minimum"]:
                errors.append(ValidationIssue(path, f"must be >= {schema['minimum']}", "schema"))
            if "maximum" in schema and instance > schema["maximum"]:
                errors.append(ValidationIssue(path, f"must be <= {schema['maximum']}", "schema"))
            if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
                errors.append(ValidationIssue(path, f"must be > {schema['exclusiveMinimum']}", "schema"))
            if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
                errors.append(ValidationIssue(path, f"must be < {schema['exclusiveMaximum']}", "schema"))

        return errors

    @staticmethod
    def _is_type(value: Any, expected: str) -> bool:
        return {
            "null": value is None,
            "boolean": isinstance(value, bool),
            "object": isinstance(value, Mapping),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        }.get(expected, False)

    @staticmethod
    def _valid_format(value: str, fmt: str) -> bool:
        try:
            if fmt == "uuid":
                uuid.UUID(value)
                return True
            if fmt == "date-time":
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return parsed.tzinfo is not None
        except (ValueError, TypeError):
            return False
        return True  # Unknown formats are annotations in JSON Schema.


def load_schema(schema_name: str, schema_dir: Path = DEFAULT_SCHEMA_DIR) -> Mapping[str, Any]:
    filename = SCHEMA_ALIASES.get(schema_name, SCHEMA_FILES.get(schema_name, schema_name))
    path = schema_dir / filename
    if not path.is_file():
        raise FileNotFoundError(f"unknown schema {schema_name!r}; expected {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _infer_schema_name(document: Mapping[str, Any]) -> str:
    schema_id = document.get("schema")
    if not isinstance(schema_id, str) or schema_id not in SCHEMA_FILES:
        raise ValueError(f"cannot infer schema from document field 'schema': {schema_id!r}")
    return schema_id


def _issue(path: str, message: str) -> ValidationIssue:
    return ValidationIssue(path, message, "semantic")


def _duplicates(values: Iterable[Any]) -> set[Any]:
    seen: set[Any] = set()
    duplicate: set[Any] = set()
    for value in values:
        if value in seen:
            duplicate.add(value)
        seen.add(value)
    return duplicate


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _critical_field_errors(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    critical = document.get("critical_fields", [])
    extensions = document.get("extensions", {})
    for index, field in enumerate(critical):
        path = _path("$.critical_fields", index)
        if field not in extensions:
            errors.append(_issue(path, f"critical field {field!r} has no value in $.extensions"))
        if field not in SUPPORTED_CRITICAL_FIELDS:
            errors.append(_issue(path, f"unknown critical field {field!r}; fail-closed rejection"))
    return errors


def _permissions_subset(child: Mapping[str, Any], parent: Mapping[str, Any], path: str) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    if not set(child["capabilities"]).issubset(parent["capabilities"]):
        errors.append(_issue(path + ".capabilities", "uses capabilities not granted by the enclosing policy"))
    for mode in ("read", "write"):
        if not set(child["filesystem"][mode]).issubset(parent["filesystem"][mode]):
            errors.append(_issue(path + f".filesystem.{mode}", "scope exceeds the enclosing filesystem permission"))
    if NETWORK_RANK[child["network"]] > NETWORK_RANK[parent["network"]]:
        errors.append(_issue(path + ".network", "network permission exceeds the enclosing policy"))
    if not set(child["secrets"]).issubset(parent["secrets"]):
        errors.append(_issue(path + ".secrets", "uses secrets not granted by the enclosing policy"))
    return errors


def _effect_errors(
    effect: Mapping[str, Any],
    path: str,
    permissions: Mapping[str, Any] | None = None,
    cache_modes: Iterable[str] = (),
) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    writes = effect["write_scope"]
    semantics = effect["write_semantics"]
    if semantics == "none" and writes:
        errors.append(_issue(path + ".write_scope", "must be empty when write_semantics is 'none'"))
    if semantics != "none" and not writes:
        errors.append(_issue(path + ".write_scope", "must be non-empty for a writing effect"))
    if semantics == "non_idempotent" and effect["replay_policy"] != "forbidden":
        errors.append(_issue(path + ".replay_policy", "non-idempotent writes require replay_policy 'forbidden'"))
    if effect["external_side_effects"] == "non_idempotent" and effect["replay_policy"] != "forbidden":
        errors.append(_issue(path + ".replay_policy", "non-idempotent external effects require replay_policy 'forbidden'"))
    if effect["network_access"] == "live" and effect["determinism"] == "deterministic":
        errors.append(_issue(path + ".determinism", "live network access cannot be declared deterministic"))

    if effect["replay_policy"] == "safe":
        safe = (
            semantics in {"none", "content_addressed"}
            and effect["external_side_effects"] == "none"
            and effect["network_access"] != "live"
            and effect["determinism"] in {"deterministic", "seeded"}
        )
        if not safe:
            errors.append(_issue(path + ".replay_policy", "'safe' conflicts with the declared effect dimensions"))

    if permissions is not None:
        if not set(effect["read_scope"]).issubset(permissions["filesystem"]["read"]):
            errors.append(_issue(path + ".read_scope", "declared reads exceed filesystem permissions"))
        if not set(effect["write_scope"]).issubset(permissions["filesystem"]["write"]):
            errors.append(_issue(path + ".write_scope", "declared writes exceed filesystem permissions"))
        if NETWORK_RANK[effect["network_access"]] > NETWORK_RANK[permissions["network"]]:
            errors.append(_issue(path + ".network_access", "declared network effect exceeds permission"))

    modes = set(cache_modes)
    if modes & DIRECT_CACHE_MODES and effect["replay_policy"] != "safe":
        errors.append(_issue(path + ".replay_policy", "EXACT/SEMANTIC reuse requires replay_policy 'safe'"))
    if "ADAPT" in modes and effect["replay_policy"] == "forbidden":
        errors.append(_issue(path + ".replay_policy", "ADAPT is forbidden for non-replayable effects"))
    return errors


def _ids_unique(items: Sequence[Mapping[str, Any]], field: str, path: str) -> list[ValidationIssue]:
    values = [item[field] for item in items]
    return [_issue(path, f"duplicate {field}: {value!r}") for value in sorted(_duplicates(values))]


def _port_maps(nodes: Sequence[Mapping[str, Any]]) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    inputs: dict[str, dict[str, str]] = {}
    outputs: dict[str, dict[str, str]] = {}
    for node in nodes:
        inputs[node["id"]] = {port["id"]: port["type"] for port in node["ports"]["inputs"]}
        outputs[node["id"]] = {port["id"]: port["type"] for port in node["ports"]["outputs"]}
    return inputs, outputs


def _graph_semantics(
    nodes: Sequence[Mapping[str, Any]],
    edges: Sequence[Mapping[str, Any]],
    loops: Sequence[Mapping[str, Any]],
    path: str,
    *,
    interface: Mapping[str, Any] | None = None,
    artifacts: Sequence[Mapping[str, Any]] | None = None,
    global_permissions: Mapping[str, Any] | None = None,
    entry_node: str | None = None,
    graph_node_style: bool = False,
) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    errors.extend(_ids_unique(nodes, "id", path + ".nodes"))
    errors.extend(_ids_unique(edges, "id", path + ".edges"))
    errors.extend(_ids_unique(loops, "id", path + ".control.loops"))
    node_ids = {node["id"] for node in nodes}
    if entry_node is not None and entry_node not in node_ids:
        errors.append(_issue(path + ".entry_node", "does not identify a declared node"))

    node_inputs, node_outputs = _port_maps(nodes)
    for index, node in enumerate(nodes):
        for direction in ("inputs", "outputs"):
            port_ids = [port["id"] for port in node["ports"][direction]]
            for duplicate in _duplicates(port_ids):
                errors.append(_issue(f"{path}.nodes[{index}].ports.{direction}", f"duplicate port {duplicate!r}"))
        permissions = node["permissions"]
        if global_permissions is not None:
            errors.extend(_permissions_subset(permissions, global_permissions, f"{path}.nodes[{index}].permissions"))
        if graph_node_style:
            modes = node["cache_policy"]["allowed_modes"]
        else:
            cache = node["policy"]["cache"]
            modes = [] if cache == "disabled" else [cache.upper()]
        errors.extend(_effect_errors(node["effects"], f"{path}.nodes[{index}].effects", permissions, modes))

    if artifacts is not None:
        errors.extend(_ids_unique(artifacts, "id", path + ".artifacts"))
        artifact_ids = {item["id"] for item in artifacts}
        for index, node in enumerate(nodes):
            for artifact_ref in node["artifact_refs"]:
                if artifact_ref not in artifact_ids:
                    errors.append(_issue(f"{path}.nodes[{index}].artifact_refs", f"unknown artifact reference {artifact_ref!r}"))

    interface_inputs = {port["id"]: port["type"] for port in (interface or {}).get("inputs", [])}
    interface_outputs = {port["id"]: port["type"] for port in (interface or {}).get("outputs", [])}
    incoming: dict[tuple[str, str], int] = {}

    def endpoint_type(endpoint: Mapping[str, Any], source: bool, edge_path: str) -> str | None:
        node = endpoint["node"]
        port = endpoint["port"]
        if source:
            if node == "@input":
                typ = interface_inputs.get(port)
            elif node == "@output":
                errors.append(_issue(edge_path, "@output cannot be an edge source"))
                return None
            else:
                typ = node_outputs.get(node, {}).get(port)
        else:
            if node == "@output":
                typ = interface_outputs.get(port)
            elif node == "@input":
                errors.append(_issue(edge_path, "@input cannot be an edge destination"))
                return None
            else:
                typ = node_inputs.get(node, {}).get(port)
        if typ is None:
            errors.append(_issue(edge_path, f"unknown {'source' if source else 'destination'} endpoint {node}.{port}"))
        return typ

    for index, edge in enumerate(edges):
        edge_path = f"{path}.edges[{index}]"
        source_type = endpoint_type(edge["from"], True, edge_path + ".from")
        target_type = endpoint_type(edge["to"], False, edge_path + ".to")
        if source_type is not None and target_type is not None and source_type != target_type:
            errors.append(_issue(edge_path, f"typed port mismatch: {source_type!r} -> {target_type!r}"))
        destination = (edge["to"]["node"], edge["to"]["port"])
        incoming[destination] = incoming.get(destination, 0) + 1
        if incoming[destination] > 1 and edge["kind"] != "CONTROL":
            errors.append(_issue(edge_path + ".to", "multiple data/feedback producers target the same port"))

    for node_index, node in enumerate(nodes):
        for port in node["ports"]["inputs"]:
            if port["required"] and incoming.get((node["id"], port["id"]), 0) != 1:
                errors.append(_issue(
                    f"{path}.nodes[{node_index}].ports.inputs",
                    f"required input {node['id']}.{port['id']} must have exactly one producer",
                ))
    for port in (interface or {}).get("outputs", []):
        if port["required"] and incoming.get(("@output", port["id"]), 0) != 1:
            errors.append(_issue(path + ".interface.outputs", f"required output {port['id']!r} is not bound exactly once"))

    edge_by_id = {edge["id"]: edge for edge in edges}
    loop_ids = {loop["id"] for loop in loops}
    for loop_index, loop in enumerate(loops):
        loop_path = f"{path}.control.loops[{loop_index}]"
        unknown_nodes = set(loop["body_nodes"]) - node_ids
        if unknown_nodes:
            errors.append(_issue(loop_path + ".body_nodes", f"unknown loop nodes: {sorted(unknown_nodes)!r}"))
        for edge_id in loop["feedback_edges"]:
            edge = edge_by_id.get(edge_id)
            if edge is None:
                errors.append(_issue(loop_path + ".feedback_edges", f"unknown feedback edge {edge_id!r}"))
            elif edge["kind"] != "FEEDBACK" or edge["loop_id"] != loop["id"]:
                errors.append(_issue(loop_path + ".feedback_edges", f"edge {edge_id!r} is not assigned to this bounded loop"))
    for index, edge in enumerate(edges):
        if edge["kind"] == "FEEDBACK":
            if edge["loop_id"] not in loop_ids:
                errors.append(_issue(f"{path}.edges[{index}].loop_id", "feedback edge must name a declared bounded loop"))
        elif edge["loop_id"] is not None:
            errors.append(_issue(f"{path}.edges[{index}].loop_id", "only FEEDBACK edges may name a loop"))

    # Excluding declared feedback edges, the executable graph must remain a DAG.
    indegree = {node_id: 0 for node_id in node_ids}
    adjacency = {node_id: [] for node_id in node_ids}
    for edge in edges:
        source, target = edge["from"]["node"], edge["to"]["node"]
        if edge["kind"] == "FEEDBACK" or source.startswith("@") or target.startswith("@"):
            continue
        adjacency[source].append(target)
        indegree[target] += 1
    ready = [node_id for node_id, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for target in adjacency[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if visited != len(node_ids):
        errors.append(_issue(path + ".edges", "contains an undeclared/unbounded cycle"))
    return errors


def _slot_default_errors(slot: Mapping[str, Any], path: str) -> list[ValidationIssue]:
    if "default" not in slot:
        return []
    value = slot["default"]
    expected = slot["type"]
    valid = {
        "string": isinstance(value, str),
        "path": isinstance(value, str),
        "artifact_ref": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "list": isinstance(value, list),
        "map": isinstance(value, Mapping),
    }[expected]
    return [] if valid else [_issue(path + ".default", f"default value does not match slot type {expected!r}")]


def _walk_strings(value: Any, path: str = "$") -> Iterable[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield from _walk_strings(child, _path(path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk_strings(child, _path(path, index))


def _template_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    release = document["release"]
    metadata = document["metadata"]
    if release["logical_id"] != f"{metadata['namespace']}/{metadata['name']}":
        errors.append(_issue("$.release.logical_id", "must equal metadata namespace/name"))
    if release["template_version"] != metadata["template_version"]:
        errors.append(_issue("$.release.template_version", "must equal metadata.template_version"))
    spec = document["spec"]
    errors.extend(_ids_unique(spec["slots"], "id", "$.spec.slots"))
    for index, slot in enumerate(spec["slots"]):
        errors.extend(_slot_default_errors(slot, f"$.spec.slots[{index}]"))
        if slot["required"] and "default" in slot:
            # A required slot may have a safe default; this is valid and intentional.
            pass
        if slot["type"] == "list" and slot["item_type"] is None:
            errors.append(_issue(f"$.spec.slots[{index}].item_type", "list slots require item_type"))
        if slot["type"] != "list" and slot["item_type"] is not None:
            errors.append(_issue(f"$.spec.slots[{index}].item_type", "item_type is only valid for list slots"))
    known_slots = {slot["id"] for slot in spec["slots"]}
    placeholder = re.compile(r"\$\{slot\.([A-Za-z][A-Za-z0-9_.-]*)\}")
    for path, text in _walk_strings([node["config"] for node in spec["nodes"]], "$.spec.nodes.config"):
        for slot_id in placeholder.findall(text):
            if slot_id not in known_slots:
                errors.append(_issue(path, f"references unknown slot {slot_id!r}"))
    errors.extend(_graph_semantics(
        spec["nodes"], spec["edges"], spec["control"]["loops"], "$.spec",
        interface=spec["interface"], artifacts=spec["artifacts"],
        global_permissions=spec["permissions"],
    ))
    return errors


def _instance_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    instance_ref = document["instance_ref"]
    inputs = document["inputs"]
    interface_inputs = {port["id"]: port for port in document["interface"]["inputs"]}
    errors.extend(_ids_unique(inputs, "port", "$.inputs"))
    for index, binding in enumerate(inputs):
        port = interface_inputs.get(binding["port"])
        if port is None:
            errors.append(_issue(f"$.inputs[{index}].port", "does not name an interface input"))
        elif binding["type"] != port["type"]:
            errors.append(_issue(f"$.inputs[{index}].type", "does not match interface port type"))
    bound = {binding["port"] for binding in inputs}
    missing = [port["id"] for port in interface_inputs.values() if port["required"] and port["id"] not in bound]
    if missing:
        errors.append(_issue("$.inputs", f"missing required input bindings: {missing!r}"))
    errors.extend(_ids_unique(document["slot_bindings"], "slot", "$.slot_bindings"))
    for path, text in _walk_strings(document):
        if "${slot." in text:
            errors.append(_issue(path, "WorkflowInstance must not contain unresolved slot placeholders"))
    errors.extend(_graph_semantics(
        document["nodes"], document["edges"], document["control"]["loops"], "$",
        interface=document["interface"], artifacts=document["artifacts"],
        global_permissions=document["permissions"],
    ))
    # Accessing the nested key here is intentional: schema-valid instances always
    # carry one canonical TemplateRelease foreign key, never parallel ad-hoc IDs.
    if not instance_ref["template_release"]["release_digest"].startswith("sha256:"):
        errors.append(_issue("$.instance_ref.template_release.release_digest", "invalid canonical release key"))
    return errors


def _graph_document_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    errors.extend(_graph_semantics(
        document["nodes"], document["edges"], document["control"]["loops"], "$",
        global_permissions=document["policies"]["permissions"],
        entry_node=document["entry_node"], graph_node_style=True,
    ))
    return errors


def _gate_errors(gates: Sequence[Mapping[str, Any]], path: str, require_pass: bool) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    names = [gate["gate"] for gate in gates]
    for duplicate in _duplicates(names):
        errors.append(_issue(path, f"duplicate gate result {duplicate!r}"))
    by_name = {gate["gate"]: gate for gate in gates}
    for index, gate in enumerate(gates):
        if gate["critical"] and gate["gate"] not in REQUIRED_REUSE_GATES:
            errors.append(_issue(f"{path}[{index}].gate", f"unknown critical gate {gate['gate']!r}; fail-closed rejection"))
    if require_pass:
        missing = REQUIRED_REUSE_GATES - set(by_name)
        if missing:
            errors.append(_issue(path, f"missing required critical gates: {sorted(missing)!r}"))
        for name in REQUIRED_REUSE_GATES & set(by_name):
            gate = by_name[name]
            if not gate["critical"] or gate["status"] != "PASS":
                errors.append(_issue(path, f"critical gate {name!r} must be explicitly PASS"))
    return errors


def _manifest_reusable(manifest: Mapping[str, Any], path: str) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    if manifest["completeness"] != "complete":
        errors.append(_issue(path + ".completeness", "direct reuse requires a complete dependency manifest"))
    for index, observation in enumerate(manifest["observed"]):
        if observation["completeness"] == "incomplete" or observation["capture_method"] == "unknown":
            errors.append(_issue(f"{path}.observed[{index}]", "incomplete/unknown dependency capture cannot support reuse"))
    return errors


def _trace_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    if _parse_time(document["ended_at"]) < _parse_time(document["started_at"]):
        errors.append(_issue("$.ended_at", "must not precede started_at"))
    instance_id = document["instance_ref"]["instance_id"]
    attempts = document["attempts"]
    attempt_ids = {attempt["attempt_id"] for attempt in attempts}
    errors.extend(_ids_unique(attempts, "attempt_id", "$.attempts"))
    attempt_keys: list[tuple[str, str, int, int]] = []

    total_tokens = 0
    total_money = 0
    for index, attempt in enumerate(attempts):
        path = f"$.attempts[{index}]"
        node = attempt["runtime_node"]
        if node["instance_id"] != instance_id:
            errors.append(_issue(path + ".runtime_node.instance_id", "must equal trace instance_ref.instance_id"))
        attempt_keys.append((node["instance_id"], node["runtime_node_id"], node["generation"], attempt["attempt_no"]))
        if attempt["span_context"]["trace_id"] != document["trace_id"]:
            errors.append(_issue(path + ".span_context.trace_id", "must equal the enclosing trace_id"))
        times = attempt["timing"]
        ordered = [times["planned_at"], times["ready_at"], times["started_at"], times["ended_at"]]
        if ordered != sorted(ordered, key=_parse_time):
            errors.append(_issue(path + ".timing", "timestamps must be planned <= ready <= started <= ended"))
        if attempt["status"] == "failure" and attempt["error"] is None:
            errors.append(_issue(path + ".error", "failure attempts require an error object"))
        if attempt["status"] == "success" and attempt["error"] is not None:
            errors.append(_issue(path + ".error", "successful attempts must not carry an error"))
        errors.extend(_permissions_subset(attempt["permissions_used"], document["authority"]["permissions_granted"], path + ".permissions_used"))
        decision = attempt["cache_decision"]
        mode = decision["final_mode"]
        cache_modes = [mode] if mode in REUSE_CACHE_MODES else []
        errors.extend(_effect_errors(attempt["effects"], path + ".effects", attempt["permissions_used"], cache_modes))
        require_pass = mode in REUSE_CACHE_MODES
        errors.extend(_gate_errors(decision["gate_results"], path + ".cache_decision.gate_results", require_pass))
        if require_pass:
            errors.extend(_manifest_reusable(attempt["dependency_manifest"], path + ".dependency_manifest"))
            if decision["source_attempt_id"] is None:
                errors.append(_issue(path + ".cache_decision.source_attempt_id", "reused/adapted results require a source attempt"))
            if not decision["candidate_artifact_digests"]:
                errors.append(_issue(path + ".cache_decision.candidate_artifact_digests", "reuse requires at least one candidate artifact"))
            if attempt["effects"]["undeclared_reads"] or attempt["effects"]["undeclared_writes"]:
                errors.append(_issue(path + ".effects", "undeclared effects forbid reuse"))
        elif mode == "MISS":
            if decision["fallback_reason"] is None:
                errors.append(_issue(path + ".cache_decision.fallback_reason", "MISS requires an audit reason"))
            if decision["source_attempt_id"] is not None:
                errors.append(_issue(path + ".cache_decision.source_attempt_id", "MISS must not name a source attempt"))
        elif mode == "DISABLED":
            if decision["requested_mode"] != "DISABLED":
                errors.append(_issue(path + ".cache_decision", "final DISABLED requires requested DISABLED"))
        total_tokens += attempt["cost"]["input_tokens"] + attempt["cost"]["output_tokens"]
        total_money += attempt["cost"]["monetary_microunits"]
        if attempt["cost"]["wall_time_ms"] > document["budget"]["wall_time_ms"]:
            errors.append(_issue(path + ".cost.wall_time_ms", "attempt exceeds run wall-time budget"))
    for duplicate in _duplicates(attempt_keys):
        errors.append(_issue("$.attempts", f"duplicate runtime-node/attempt composite identity: {duplicate!r}"))
    if total_tokens > document["budget"]["model_tokens"]:
        errors.append(_issue("$.budget.model_tokens", "aggregate attempt tokens exceed the run budget"))
    if total_money > document["budget"]["monetary_microunits"]:
        errors.append(_issue("$.budget.monetary_microunits", "aggregate attempt cost exceeds the run budget"))

    events = document["graph_delta_events"]
    errors.extend(_ids_unique(events, "event_id", "$.graph_delta_events"))
    sequences = [event["sequence"] for event in events]
    if sequences != sorted(sequences) or len(sequences) != len(set(sequences)):
        errors.append(_issue("$.graph_delta_events", "event sequence numbers must be unique and increasing"))
    added_dynamic_nodes: set[tuple[str, str, int]] = set()
    for index, event in enumerate(events):
        path = f"$.graph_delta_events[{index}]"
        is_node = event["event_type"].startswith("NODE_")
        if is_node and (event["node"] is None or event["edge"] is not None):
            errors.append(_issue(path, "node delta events require node and forbid edge payloads"))
        if not is_node and (event["edge"] is None or event["node"] is not None):
            errors.append(_issue(path, "edge delta events require edge and forbid node payloads"))
        if event["actor_attempt_id"] is not None and event["actor_attempt_id"] not in attempt_ids:
            errors.append(_issue(path + ".actor_attempt_id", "does not reference an attempt in this trace"))
        identities: list[Mapping[str, Any]] = []
        if event["node"] is not None:
            identities.append(event["node"])
        if event["edge"] is not None:
            identities.extend([event["edge"]["from_node"], event["edge"]["to_node"]])
        for identity in identities:
            if identity["instance_id"] != instance_id:
                errors.append(_issue(path, "graph delta identity belongs to another WorkflowInstance"))
        if event["event_type"] == "NODE_ADDED" and event["node"] is not None:
            identity = event["node"]
            added_dynamic_nodes.add((identity["instance_id"], identity["runtime_node_id"], identity["generation"]))
    for index, attempt in enumerate(attempts):
        identity = attempt["runtime_node"]
        key = (identity["instance_id"], identity["runtime_node_id"], identity["generation"])
        if identity["template_node_id"] is None and key not in added_dynamic_nodes:
            errors.append(_issue(f"$.attempts[{index}].runtime_node", "dynamic runtime node lacks a NODE_ADDED GraphDeltaEvent"))
    return errors


def _artifact_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    digest_hex = document["artifact_id"].split(":", 1)[1]
    if not document["storage_ref"].endswith("/" + digest_hex):
        errors.append(_issue("$.storage_ref", "CAS location digest must equal artifact_id"))
    if document["expires_at"] is not None and _parse_time(document["expires_at"]) <= _parse_time(document["created_at"]):
        errors.append(_issue("$.expires_at", "must be later than created_at"))
    effects = document["producer"]["effects"]
    errors.extend(_effect_errors(effects, "$.producer.effects"))
    policy = document["reuse_policy"]
    if policy["publish_scope"] != "local" or policy["allowed_cache_modes"]:
        if document["dependencies"]["completeness"] != "complete":
            errors.append(_issue("$.dependencies.completeness", "published/cacheable artifacts require complete dependencies"))
    errors.extend(_effect_errors(effects, "$.producer.effects", cache_modes=policy["allowed_cache_modes"]))
    return errors


def _certificate_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    issued = _parse_time(document["validity"]["issued_at"])
    expires = document["validity"]["expires_at"]
    if expires is not None and _parse_time(expires) <= issued:
        errors.append(_issue("$.validity.expires_at", "must be later than issued_at"))
    mode = document["cache_decision"]["authorized_mode"]
    direct = mode in {"EXACT", "SEMANTIC", "ADAPT"}
    errors.extend(_gate_errors(document["cache_decision"]["gate_results"], "$.cache_decision.gate_results", direct))
    if direct:
        if document["inputs"]["completeness"] != "complete":
            errors.append(_issue("$.inputs.completeness", "direct/adapt reuse requires complete dependencies"))
        for index, validator in enumerate(document["validators"]):
            if validator["result"] != "pass":
                errors.append(_issue(f"$.validators[{index}].result", "authorized reuse requires explicit validator pass"))
            if validator["expires_at"] is not None and _parse_time(validator["expires_at"]) <= issued:
                errors.append(_issue(f"$.validators[{index}].expires_at", "validator evidence expires before certificate issuance"))
        if document["effects"]["undeclared_reads"] or document["effects"]["undeclared_writes"]:
            errors.append(_issue("$.effects", "undeclared effects forbid authorized reuse"))
    errors.extend(_effect_errors(document["effects"], "$.effects", cache_modes=[] if mode == "EVIDENCE_ONLY" else [mode]))
    expected_result = {
        "EXACT": "execution-equivalent",
        "SEMANTIC": "result-satisfies",
        "ADAPT": "result-satisfies",
        "EVIDENCE_ONLY": "evidence-only",
    }[mode]
    if document["task"]["result_mode"] != expected_result:
        errors.append(_issue("$.task.result_mode", f"must be {expected_result!r} for authorized mode {mode}"))
    if not set(document["authority"]["capabilities_used"]).issubset(document["security"]["capabilities_granted"]):
        errors.append(_issue("$.authority.capabilities_used", "certificate claims capabilities outside the granted set"))
    return errors


def _contracts_semantics(document: Mapping[str, Any]) -> list[ValidationIssue]:
    errors = _critical_field_errors(document)
    task = document["task"]
    acceptance = document["acceptance"]
    if task["acceptance_id"] != acceptance["acceptance_id"]:
        errors.append(_issue("$.task.acceptance_id", "must reference $.acceptance.acceptance_id"))
    criteria = {criterion["criterion_id"]: criterion for criterion in acceptance["criteria"]}
    if len(criteria) != len(acceptance["criteria"]):
        errors.append(_issue("$.acceptance.criteria", "criterion_id values must be unique"))
    artifact_digests = {artifact["artifact_digest"] for artifact in document["artifacts"]}
    missing_inputs = set(task["input_artifact_digests"]) - artifact_digests
    if missing_inputs:
        errors.append(_issue("$.task.input_artifact_digests", f"unknown artifact digests: {sorted(missing_inputs)!r}"))
    patch_digests: set[str] = set()
    for index, patch in enumerate(document["patches"]):
        patch_digests.add(patch["patch_digest"])
        if patch["base_artifact_digest"] not in artifact_digests or patch["result_artifact_digest"] not in artifact_digests:
            errors.append(_issue(f"$.patches[{index}]", "patch base/result must reference declared artifacts"))
    for index, verification in enumerate(document["verifications"]):
        path = f"$.verifications[{index}]"
        if verification["acceptance_id"] != acceptance["acceptance_id"]:
            errors.append(_issue(path + ".acceptance_id", "references a different acceptance contract"))
        if verification["subject_digest"] not in artifact_digests | patch_digests:
            errors.append(_issue(path + ".subject_digest", "does not reference a declared artifact or patch"))
        result_map = {result["criterion_id"]: result for result in verification["results"]}
        if len(result_map) != len(verification["results"]):
            errors.append(_issue(path + ".results", "criterion results must be unique"))
        unknown = set(result_map) - set(criteria)
        if unknown:
            errors.append(_issue(path + ".results", f"unknown acceptance criteria: {sorted(unknown)!r}"))
        required = {name for name, criterion in criteria.items() if criterion["required"]}
        missing = required - set(result_map)
        if missing:
            errors.append(_issue(path + ".results", f"missing required criterion results: {sorted(missing)!r}"))
        required_pass = all(result_map[name]["status"] == "pass" for name in required if name in result_map) and not missing
        if verification["overall"] == "pass" and not required_pass:
            errors.append(_issue(path + ".overall", "cannot be pass when a required result is fail/unknown/missing"))
        if verification["overall"] != "pass" and required_pass:
            errors.append(_issue(path + ".overall", "must be pass when every required criterion explicitly passes"))
    return errors


SEMANTIC_VALIDATORS = {
    "wea.graph/v1": _graph_document_semantics,
    "wea.trace/v1": _trace_semantics,
    "wea.workflow-template/v1": _template_semantics,
    "wea.workflow-instance/v1": _instance_semantics,
    "wea.artifact/v1": _artifact_semantics,
    "wea.reuse-certificate/v1": _certificate_semantics,
    "wea.contracts/v1": _contracts_semantics,
}


def validate_document(
    document: Mapping[str, Any],
    schema_name: str | None = None,
    *,
    schema_dir: Path = DEFAULT_SCHEMA_DIR,
    semantic: bool = True,
) -> list[ValidationIssue]:
    """Return every structural and semantic issue; an empty list means valid."""

    selected = schema_name or _infer_schema_name(document)
    schema = load_schema(selected, schema_dir)
    issues = StructuralValidator(schema).validate(document)
    if issues or not semantic:
        return issues
    schema_id = document["schema"]
    validator = SEMANTIC_VALIDATORS.get(schema_id)
    if validator is None:
        return [_issue("$.schema", f"no semantic validator registered for {schema_id!r}")]
    return validator(document)


def assert_valid_document(
    document: Mapping[str, Any],
    schema_name: str | None = None,
    *,
    schema_dir: Path = DEFAULT_SCHEMA_DIR,
) -> None:
    issues = validate_document(document, schema_name, schema_dir=schema_dir)
    if issues:
        raise IRValidationError(issues)


def validate_file(path: Path, schema_name: str | None = None) -> list[ValidationIssue]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [ValidationIssue("$", str(exc), "parse")]
    if not isinstance(document, Mapping):
        return [ValidationIssue("$", "IR document must be a JSON object", "parse")]
    try:
        return validate_document(document, schema_name)
    except (ValueError, FileNotFoundError, KeyError) as exc:
        return [ValidationIssue("$", str(exc), "configuration")]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="JSON IR files to validate")
    parser.add_argument("--schema", choices=sorted(SCHEMA_ALIASES), help="override schema inference")
    parser.add_argument("--structural-only", action="store_true", help="skip cross-field semantic checks")
    parser.add_argument("--json", action="store_true", dest="json_output", help="emit machine-readable results")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    failed = False
    results: list[dict[str, Any]] = []
    for path in args.paths:
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(document, Mapping):
                raise ValueError("IR document must be a JSON object")
            issues = validate_document(document, args.schema, semantic=not args.structural_only)
        except (OSError, json.JSONDecodeError, ValueError, FileNotFoundError, KeyError) as exc:
            issues = [ValidationIssue("$", str(exc), "parse")]
        failed = failed or bool(issues)
        if args.json_output:
            results.append({
                "path": str(path),
                "valid": not issues,
                "issues": [issue.__dict__ for issue in issues],
            })
        elif issues:
            print(f"INVALID {path}")
            for issue in issues:
                print(f"  - {issue}")
        else:
            print(f"VALID   {path}")
    if args.json_output:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
