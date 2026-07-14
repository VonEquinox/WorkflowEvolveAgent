import unittest

from prototypes.scheduler import (
    AttemptOutcome,
    CycleError,
    DynamicDAGScheduler,
    EffectClass,
    EventType,
    Failure,
    FailureKind,
    LateEdgeError,
    NodeState,
    RetryClass,
    RetryDisposition,
    TriggerRule,
    classify_retry,
)


class DynamicDAGSchedulerTests(unittest.TestCase):
    def test_diamond_propagates_completion_events(self):
        scheduler = DynamicDAGScheduler(concurrency=2)
        scheduler.add_node("a", duration=1.0, result="A")
        scheduler.add_node("b", duration=2.0, result="B")
        scheduler.add_node("c", duration=1.0, result="C")
        scheduler.add_node("d", duration=0.0, result="D")
        scheduler.add_edge("a", "b")
        scheduler.add_edge("a", "c")
        scheduler.add_edge("b", "d")
        scheduler.add_edge("c", "d")
        scheduler.seal_all()

        scheduler.run()

        self.assertTrue(scheduler.all_terminal)
        self.assertEqual(
            [scheduler.state(node_id) for node_id in ("a", "b", "c", "d")],
            [NodeState.SUCCEEDED] * 4,
        )
        self.assertEqual(scheduler.start_order, ("a", "b", "c", "d"))
        self.assertEqual(scheduler.node("a").attempt_start_times, [0.0])
        self.assertEqual(scheduler.node("b").attempt_start_times, [1.0])
        self.assertEqual(scheduler.node("c").attempt_start_times, [1.0])
        self.assertEqual(scheduler.node("d").attempt_start_times, [3.0])
        self.assertEqual(scheduler.node("d").required_satisfied, 2)
        self.assertEqual(scheduler.result("d"), "D")

    def test_success_callback_can_add_and_seal_dynamic_node(self):
        def expand_graph(simulator, _node, result):
            simulator.apply_event(
                "ADD_NODE",
                node_id="dynamic",
                duration=0.5,
                result=result + "-child",
            )
            simulator.apply_event(
                EventType.ADD_EDGE,
                parent_id="router",
                child_id="dynamic",
            )
            simulator.apply_event(EventType.SEAL_NODE, node_id="dynamic")

        scheduler = DynamicDAGScheduler()
        scheduler.add_node(
            "router",
            duration=1.0,
            result="route",
            on_success=expand_graph,
        )
        scheduler.seal_node("router")

        scheduler.run()

        self.assertEqual(scheduler.state("router"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.state("dynamic"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.node("dynamic").attempt_start_times, [1.0])
        self.assertEqual(scheduler.node("dynamic").required_satisfied, 1)
        self.assertEqual(scheduler.result("dynamic"), "route-child")
        self.assertEqual(len(scheduler.events_of(EventType.ADD_NODE)), 2)

    def test_sealed_node_rejects_late_incoming_edge(self):
        scheduler = DynamicDAGScheduler()
        scheduler.add_node("parent")
        scheduler.add_node("child")
        scheduler.seal_node("child")

        with self.assertRaises(LateEdgeError):
            scheduler.add_edge("parent", "child")

        self.assertEqual(scheduler.node("child").required_total, 0)

    def test_add_edge_rejects_cycle_without_mutating_graph(self):
        scheduler = DynamicDAGScheduler()
        for node_id in ("a", "b", "c"):
            scheduler.add_node(node_id)
        scheduler.add_edge("a", "b")
        scheduler.add_edge("b", "c")

        with self.assertRaises(CycleError):
            scheduler.add_edge("c", "a")

        self.assertEqual(scheduler.node("a").required_total, 0)
        self.assertEqual([edge.child_id for edge in scheduler.node("c").outgoing], [])

    def test_all_success_all_done_and_any_success_failure_propagation(self):
        scheduler = DynamicDAGScheduler(concurrency=6)
        scheduler.add_node(
            "bad",
            attempts=[
                AttemptOutcome.failure(
                    Failure(FailureKind.PERMANENT, "deterministic failure"),
                    duration=1.0,
                )
            ],
        )
        scheduler.add_node("good", duration=2.0, result="ok")
        scheduler.add_node("all_success", trigger_rule=TriggerRule.ALL_SUCCESS)
        scheduler.add_node("all_done", trigger_rule=TriggerRule.ALL_DONE)
        scheduler.add_node("any_success", trigger_rule=TriggerRule.ANY_SUCCESS)

        for child in ("all_success", "all_done", "any_success"):
            scheduler.add_edge("bad", child)
            scheduler.add_edge("good", child)
        scheduler.seal_all()

        scheduler.run()

        all_success = scheduler.node("all_success")
        self.assertEqual(all_success.state, NodeState.FAILED)
        self.assertEqual(all_success.attempt, 0)
        self.assertEqual(all_success.completed_at, 1.0)
        self.assertEqual(scheduler.state("all_done"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.state("any_success"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.node("all_done").attempt_start_times, [2.0])
        self.assertEqual(scheduler.node("any_success").attempt_start_times, [2.0])

    def test_quorum_waits_for_threshold_and_detects_impossibility(self):
        scheduler = DynamicDAGScheduler(concurrency=5)
        scheduler.add_node("p1", duration=1.0, result=1)
        scheduler.add_node(
            "p2",
            attempts=[
                AttemptOutcome.failure(FailureKind.PERMANENT, duration=2.0)
            ],
        )
        scheduler.add_node("p3", duration=3.0, result=3)
        scheduler.add_node("q2", trigger_rule=TriggerRule.QUORUM, quorum=2)
        scheduler.add_node("q3", trigger_rule="QUORUM(3)")
        for child in ("q2", "q3"):
            for parent in ("p1", "p2", "p3"):
                scheduler.add_edge(parent, child)
        scheduler.seal_all()

        scheduler.run()

        self.assertEqual(scheduler.state("q2"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.node("q2").attempt_start_times, [3.0])
        self.assertEqual(scheduler.state("q3"), NodeState.FAILED)
        self.assertEqual(scheduler.node("q3").attempt, 0)
        self.assertEqual(scheduler.node("q3").completed_at, 2.0)

    def test_result_ledger_commits_once_and_rejects_duplicate(self):
        scheduler = DynamicDAGScheduler(concurrency=1)
        node = scheduler.add_node("manual", auto_complete=False)
        scheduler.seal_node(node)
        scheduler.run()
        generation = node.attempt_generation

        self.assertEqual(node.state, NodeState.RUNNING)
        self.assertTrue(
            scheduler.deliver_success("manual", "first", generation=generation)
        )
        self.assertFalse(
            scheduler.deliver_success("manual", "second", generation=generation)
        )

        self.assertEqual(len(scheduler.ledger), 1)
        self.assertEqual(scheduler.result("manual"), "first")
        self.assertEqual(node.duplicate_results_rejected, 1)
        self.assertEqual(scheduler.resource_manager.running, 0)

    def test_quota_admission_uses_concurrency_tpm_and_rpm_buckets(self):
        with self.subTest("concurrency and TPM"):
            scheduler = DynamicDAGScheduler(concurrency=1, tpm=10)
            scheduler.add_node(
                "first",
                estimated_tokens=6,
                duration=10.0,
                actual_tokens=6,
            )
            scheduler.add_node(
                "second",
                estimated_tokens=6,
                duration=0.0,
                actual_tokens=6,
            )
            scheduler.seal_all()

            scheduler.run()

            self.assertEqual(scheduler.node("first").attempt_start_times, [0.0])
            self.assertAlmostEqual(
                scheduler.node("second").attempt_start_times[0], 12.0
            )
            self.assertTrue(
                any(
                    event.node_id == "second"
                    for event in scheduler.events_of(EventType.ADMISSION_WAIT)
                )
            )

        with self.subTest("RPM"):
            scheduler = DynamicDAGScheduler(concurrency=2, rpm=1)
            scheduler.add_node("r1", duration=0.0)
            scheduler.add_node("r2", duration=0.0)
            scheduler.seal_all()

            scheduler.run()

            self.assertEqual(scheduler.node("r1").attempt_start_times, [0.0])
            self.assertAlmostEqual(scheduler.node("r2").attempt_start_times[0], 60.0)

    def test_retry_classification_and_deterministic_retry_timer(self):
        scheduler = DynamicDAGScheduler(concurrency=2)
        scheduler.add_node(
            "transient",
            attempts=[
                AttemptOutcome.failure(
                    Failure(FailureKind.RATE_LIMITED, retry_after=2.0),
                    duration=1.0,
                ),
                AttemptOutcome.success("recovered", duration=1.0),
            ],
            max_attempts=2,
            retry_class=RetryClass.TRANSIENT_ONLY,
        )
        scheduler.add_node(
            "permanent",
            attempts=[
                AttemptOutcome.failure(FailureKind.INVALID_REQUEST, duration=0.5),
                AttemptOutcome.success("must-not-run"),
            ],
            max_attempts=3,
            retry_class=RetryClass.SAFE,
        )
        scheduler.seal_all()

        scheduler.run()

        self.assertEqual(scheduler.result("transient"), "recovered")
        self.assertEqual(
            scheduler.node("transient").attempt_start_times,
            [0.0, 3.0],
        )
        self.assertEqual(scheduler.node("transient").completed_at, 4.0)
        self.assertEqual(scheduler.state("permanent"), NodeState.FAILED)
        self.assertEqual(scheduler.node("permanent").attempt, 1)
        self.assertEqual(
            classify_retry(
                FailureKind.UNKNOWN_EFFECT,
                RetryClass.SAFE,
                EffectClass.NON_IDEMPOTENT,
            ),
            RetryDisposition.RECONCILE,
        )

    def test_cancel_increments_generation_and_rejects_late_result(self):
        scheduler = DynamicDAGScheduler(concurrency=1)
        scheduler.add_node("slow", duration=5.0, result="too late")
        scheduler.add_node("cleanup", trigger_rule=TriggerRule.ALL_DONE)
        scheduler.add_edge("slow", "cleanup")
        scheduler.seal_all()
        scheduler.schedule_cancel("slow", delay=2.0)

        scheduler.run()

        slow = scheduler.node("slow")
        self.assertEqual(slow.state, NodeState.CANCELLED)
        self.assertEqual(slow.attempt_generation, 2)
        self.assertNotIn("slow", scheduler.ledger)
        self.assertEqual(slow.late_results_rejected, 1)
        self.assertEqual(scheduler.state("cleanup"), NodeState.SUCCEEDED)
        self.assertEqual(scheduler.node("cleanup").attempt_start_times, [2.0])
        rejection = scheduler.events_of(EventType.RESULT_REJECTED)[0]
        self.assertEqual(rejection.details["reason"], "stale_generation")


if __name__ == "__main__":
    unittest.main()
