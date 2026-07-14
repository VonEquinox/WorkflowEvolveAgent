from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.validate_ir import SCHEMA_FILES, StructuralValidator, load_schema, validate_document  # noqa: E402


class IRSchemaTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.valid_dir = ROOT / "examples" / "valid"
        cls.invalid_dir = ROOT / "examples" / "invalid"

    @staticmethod
    def load(path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def assertValid(self, document: dict) -> None:
        issues = validate_document(document)
        self.assertEqual([], issues, "\n".join(str(issue) for issue in issues))

    def assertInvalid(self, document: dict, needle: str | None = None) -> None:
        issues = validate_document(document)
        self.assertTrue(issues, "document unexpectedly validated")
        if needle is not None:
            rendered = "\n".join(str(issue) for issue in issues)
            self.assertIn(needle, rendered)

    def test_schema_catalog_is_versioned_and_strict(self) -> None:
        self.assertEqual(7, len(SCHEMA_FILES))
        for schema_id, filename in SCHEMA_FILES.items():
            with self.subTest(schema=schema_id):
                schema = load_schema(filename)
                self.assertEqual("https://json-schema.org/draft/2020-12/schema", schema["$schema"])
                self.assertFalse(schema["additionalProperties"])
                self.assertEqual("1.0.0", schema["properties"]["schema_version"]["const"])
                self.assertEqual(schema_id, schema["properties"]["schema"]["const"])

    def test_all_valid_examples(self) -> None:
        paths = sorted(self.valid_dir.glob("*.json"))
        self.assertEqual(7, len(paths))
        for path in paths:
            with self.subTest(path=path.name):
                self.assertValid(self.load(path))

    def test_all_invalid_examples(self) -> None:
        paths = sorted(self.invalid_dir.glob("*.json"))
        self.assertEqual(7, len(paths))
        for path in paths:
            with self.subTest(path=path.name):
                self.assertInvalid(self.load(path))

    def test_unknown_critical_extension_is_structurally_valid_but_semantically_rejected(self) -> None:
        document = self.load(self.invalid_dir / "graph_unknown_critical.json")
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "unknown critical field")

    def test_unknown_critical_cache_gate_fails_closed_in_semantic_layer(self) -> None:
        document = self.load(self.invalid_dir / "reuse-certificate_unknown-critical-gate.json")
        schema = load_schema("reuse-certificate")
        self.assertEqual([], StructuralValidator(schema).validate(document))
        self.assertInvalid(document, "unknown critical gate")

    def test_exact_cache_requires_complete_dependencies(self) -> None:
        document = self.load(self.invalid_dir / "trace_incomplete-cache-and-unknown-gate.json")
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "complete dependency manifest")

    def test_typed_ports_are_checked_across_edges(self) -> None:
        document = self.load(self.valid_dir / "workflow-template.json")
        document["spec"]["nodes"][1]["ports"]["inputs"][0]["type"] = "wea/Artifact@1"
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "typed port mismatch")

    def test_effect_dimensions_are_orthogonal_but_coherent(self) -> None:
        document = self.load(self.valid_dir / "graph.json")
        effect = document["nodes"][0]["effects"]
        effect["write_semantics"] = "non_idempotent"
        effect["replay_policy"] = "safe"
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "non-idempotent writes require replay_policy 'forbidden'")

    def test_template_release_foreign_key_is_canonical(self) -> None:
        document = self.load(self.valid_dir / "workflow-template.json")
        document["release"]["logical_id"] = "other/template"
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "must equal metadata namespace/name")

    def test_dynamic_runtime_node_requires_graph_delta_event(self) -> None:
        document = self.load(self.valid_dir / "trace.json")
        runtime_node = document["attempts"][0]["runtime_node"]
        runtime_node["template_node_id"] = None
        document["graph_delta_events"] = [{
            "event_id": "sha256:" + "9" * 64,
            "sequence": 1,
            "occurred_at": "2026-07-13T12:00:00Z",
            "event_type": "NODE_ADDED",
            "actor_attempt_id": None,
            "node": copy.deepcopy(runtime_node),
            "edge": None,
            "reason_digest": "sha256:" + "8" * 64,
        }]
        self.assertValid(document)

        document["graph_delta_events"] = []
        self.assertInvalid(document, "lacks a NODE_ADDED GraphDeltaEvent")

    def test_unbounded_loop_is_rejected_structurally(self) -> None:
        document = self.load(self.invalid_dir / "workflow-template_unbounded-loop.json")
        issues = validate_document(document, semantic=False)
        self.assertTrue(issues)
        self.assertIn("max_iterations", "\n".join(str(issue) for issue in issues))

    def test_acceptance_unknown_cannot_be_reported_as_pass(self) -> None:
        document = self.load(self.invalid_dir / "contracts_unknown-acceptance.json")
        self.assertEqual([], validate_document(document, semantic=False))
        self.assertInvalid(document, "cannot be pass")


if __name__ == "__main__":
    unittest.main()
