"""Tests for the zero-dependency PVF attribution prototype."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prototypes.attribution import (  # noqa: E402
    OUTPUT_SCHEMA,
    TraceValidationError,
    attribute_trace,
    validate_trace,
)


def chain_trace(utility: float) -> dict:
    return {
        "trace_id": "chain",
        "occurrences": [
            {
                "id": "source#1",
                "output_artifact_ids": ["source-output"],
                "cost": {
                    "tokens": 10,
                    "wall_time_ms": 10,
                    "critical_path_time_ms": 10,
                },
            },
            {
                "id": "sink#1",
                "output_artifact_ids": ["sink-output"],
                "cost": {
                    "tokens": 20,
                    "wall_time_ms": 20,
                    "critical_path_time_ms": 20,
                },
            },
        ],
        "artifacts": [
            {"id": "source-output", "producer": "source#1", "self_weight": 1.0},
            {"id": "sink-output", "producer": "sink#1", "self_weight": 1.0},
        ],
        "relations": [
            {
                "source": "source-output",
                "target": "sink-output",
                "relation": "derive",
                "weight": 1.0,
            }
        ],
        "terminal_anchors": [
            {"artifact_id": "sink-output", "utility": utility}
        ],
    }


class AttributionTests(unittest.TestCase):
    def test_positive_terminal_credit_propagates_in_reverse_topological_order(self) -> None:
        result = attribute_trace(chain_trace(1.0))

        self.assertEqual(result["occurrence_topological_order"], ["source#1", "sink#1"])
        self.assertAlmostEqual(result["artifact_credit"]["sink-output"], 1.0)
        self.assertAlmostEqual(result["artifact_credit"]["source-output"], 0.5)
        self.assertAlmostEqual(result["node_credit"]["sink#1"], 1.0)
        self.assertAlmostEqual(result["node_credit"]["source#1"], 0.5)
        self.assertEqual(result["metrics"]["dead_nodes"], [])
        self.assertAlmostEqual(result["metrics"]["consumer_coverage"], 0.5)
        self.assertAlmostEqual(result["metrics"]["provenance_coverage"], 1.0)

    def test_negative_terminal_credit_preserves_sign(self) -> None:
        result = attribute_trace(chain_trace(-1.0))

        self.assertAlmostEqual(result["node_credit"]["sink#1"], -1.0)
        self.assertAlmostEqual(result["node_credit"]["source#1"], -0.5)
        self.assertEqual(
            result["metrics"]["low_credit_nodes"], ["source#1", "sink#1"]
        )
        self.assertAlmostEqual(result["metrics"]["critical_path_waste_rate"], 1.0)

    def test_no_terminal_path_is_dead_cost_and_critical_path_waste(self) -> None:
        trace = chain_trace(1.0)
        trace["occurrences"].append(
            {
                "id": "orphan#1",
                "output_artifact_ids": ["orphan-output"],
                "cost": {
                    "tokens": 30,
                    "dollars": 3.0,
                    "wall_time_ms": 30,
                    "critical_path_time_ms": 30,
                },
            }
        )
        trace["artifacts"].append(
            {"id": "orphan-output", "producer": "orphan#1", "self_weight": 1.0}
        )

        result = attribute_trace(trace)
        metrics = result["metrics"]

        self.assertFalse(result["nodes"]["orphan#1"]["terminal_reachable"])
        self.assertTrue(result["nodes"]["orphan#1"]["dead"])
        self.assertEqual(metrics["dead_nodes"], ["orphan#1"])
        self.assertAlmostEqual(metrics["dead_cost"], 30.0)
        self.assertAlmostEqual(metrics["dead_cost_rate"], 0.5)
        self.assertAlmostEqual(metrics["critical_path_waste_ms"], 30.0)
        self.assertAlmostEqual(metrics["critical_path_waste_rate"], 0.5)
        self.assertAlmostEqual(
            metrics["dead_cost_breakdown"]["dollars"]["dead"], 3.0
        )

    def test_common_source_and_self_do_not_create_sibling_credit(self) -> None:
        trace = {
            "trace_id": "common-source",
            "occurrences": [
                {
                    "id": "worker-a#1",
                    "output_artifact_ids": ["answer-a"],
                    "cost": {"tokens": 10},
                },
                {
                    "id": "worker-b#1",
                    "output_artifact_ids": ["answer-b"],
                    "cost": {"tokens": 10},
                },
            ],
            "artifacts": [
                {"id": "public-doc", "producer": "SELF"},
                {"id": "answer-a", "producer": "worker-a#1"},
                {"id": "answer-b", "producer": "worker-b#1"},
                {"id": "final", "producer": None},
            ],
            "relations": [
                {
                    "source": "public-doc",
                    "target": "answer-a",
                    "relation": "derive",
                    "weight": 1.0,
                },
                {"source": "SELF", "target": "answer-a", "weight": 1.0},
                {
                    "source": "public-doc",
                    "target": "answer-b",
                    "relation": "derive",
                    "weight": 1.0,
                },
                {"source": "SELF", "target": "answer-b", "weight": 1.0},
                {
                    "source": "answer-a",
                    "target": "final",
                    "relation": "derive",
                    "weight": 1.0,
                },
                {"source": "SELF", "target": "final", "weight": 1.0},
            ],
            "terminal_anchors": [{"artifact_id": "final", "utility": 1.0}],
        }

        result = attribute_trace(trace)

        self.assertAlmostEqual(result["node_credit"]["worker-a#1"], 0.5)
        self.assertAlmostEqual(result["node_credit"]["worker-b#1"], 0.0)
        self.assertTrue(result["nodes"]["worker-b#1"]["dead"])
        self.assertAlmostEqual(result["external_credit"]["SELF"], 0.25)
        self.assertAlmostEqual(result["metrics"]["provenance_coverage"], 1.0)
        self.assertTrue(result["artifacts"]["final"]["provenance_tracked"])

    def test_occurrence_cycle_is_rejected_and_requests_unfolding(self) -> None:
        trace = {
            "occurrences": [
                {"id": "retry#1", "predecessors": ["retry#2"]},
                {"id": "retry#2", "predecessors": ["retry#1"]},
            ],
            "artifacts": [],
            "terminal_anchors": [],
        }

        with self.assertRaisesRegex(TraceValidationError, "cycle.*time-unfolded"):
            validate_trace(trace)

    def test_artifact_relation_cycle_is_rejected(self) -> None:
        trace = {
            "occurrences": [
                {
                    "id": "node#1",
                    "output_artifact_ids": ["a", "b"],
                }
            ],
            "artifacts": [
                {"id": "a", "producer": "node#1"},
                {"id": "b", "producer": "node#1"},
            ],
            "relations": [
                {"source": "a", "target": "b", "weight": 1.0},
                {"source": "b", "target": "a", "weight": 1.0},
            ],
            "terminal_anchors": [],
        }

        with self.assertRaisesRegex(TraceValidationError, "artifact relation DAG.*cycle"):
            attribute_trace(trace)

    def test_cli_reads_sample_trace_and_emits_metrics_json(self) -> None:
        script = ROOT / "prototypes" / "attribution.py"
        sample = ROOT / "examples" / "sample_trace.json"
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"

        completed = subprocess.run(
            [sys.executable, str(script), str(sample)],
            cwd=str(ROOT),
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        document = json.loads(completed.stdout)
        self.assertEqual(document["schema"], OUTPUT_SCHEMA)
        self.assertEqual(document["method"], "PVF")
        self.assertIn("node_credit", document)
        self.assertIn("dead_cost_rate", document["metrics"])
        self.assertGreater(document["node_credit"]["verify#1"], 0.0)
        self.assertLess(document["node_credit"]["reject#1"], 0.0)
        self.assertIn("brainstorm#1", document["metrics"]["dead_nodes"])


if __name__ == "__main__":
    unittest.main()
