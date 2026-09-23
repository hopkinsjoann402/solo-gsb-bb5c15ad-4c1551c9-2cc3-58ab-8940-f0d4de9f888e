"""Tests for the scoring math: calibration, totals, ranking and reversals."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.scoring import (
    MAD_K,
    analyze,
    compare_contestants,
    competition_rank,
    robust_params,
    stability_experiment,
)


def recs(data):
    # data: list of (contestant, judge, item, score)
    return [
        {"id": i + 1, "contestant": c, "judge": j, "item": it, "score": s}
        for i, (c, j, it, s) in enumerate(data)
    ]


class TestRobustParams(unittest.TestCase):
    def test_median_and_mad(self):
        med, raw, scaled = robust_params([1, 2, 3, 4, 100])
        self.assertEqual(med, 3)
        # deviations: 2,1,0,1,97 -> median 1
        self.assertEqual(raw, 1)
        self.assertAlmostEqual(scaled, MAD_K)

    def test_zero_spread(self):
        med, raw, scaled = robust_params([5, 5, 5])
        self.assertEqual((med, raw, scaled), (5, 0, 0))


class TestRank(unittest.TestCase):
    def test_competition_ranking_ties(self):
        ranks = competition_rank([("a", 10.0), ("b", 10.0), ("c", 9.0), ("d", 8.0)])
        self.assertEqual(ranks["a"], 1)
        self.assertEqual(ranks["b"], 1)
        self.assertEqual(ranks["c"], 3)
        self.assertEqual(ranks["d"], 4)


class TestCalibration(unittest.TestCase):
    def setUp(self):
        # Two judges with offset/scale differences, two items, two contestants.
        # Judge A tight low range; judge B wide high range.
        self.data = [
            ("C1", "JA", "I1", 8.0),
            ("C2", "JA", "I1", 7.0),
            ("C1", "JA", "I2", 9.0),
            ("C2", "JA", "I2", 6.0),
            ("C1", "JB", "I1", 12.0),
            ("C2", "JB", "I1", 10.0),
            ("C1", "JB", "I2", 13.0),
            ("C2", "JB", "I2", 9.0),
        ]

    def test_zscore_centered(self):
        a = analyze(recs(self.data), {}, "judge")
        by_judge = {g["judge"]: g for g in a["groups"]}
        # JB: values 12,10,13,9 -> median 11, deviations 1,1,2,2 -> raw MAD 1.5
        self.assertAlmostEqual(by_judge["JB"]["median"], 11)
        self.assertAlmostEqual(by_judge["JB"]["raw_mad"], 1.5)
        # Every judge's mean robust z across their own scores should be ~0 here
        # because symmetric deviations around the median.
        for block in a["contestants"]:
            for ib in block["items"]:
                for s in ib["scores"]:
                    if s["judge"] == "JB" and s["raw"] == 11:
                        self.assertAlmostEqual(s["z"], 0.0)

    def test_totals_and_ranks(self):
        a = analyze(recs(self.data), {}, "judge")
        blocks = {b["contestant"]: b for b in a["contestants"]}
        # C1 wins every item under both judges -> rank 1 raw and calibrated
        self.assertEqual(blocks["C1"]["raw_rank"], 1)
        self.assertEqual(blocks["C1"]["cal_rank"], 1)
        self.assertEqual(blocks["C1"]["eff_rank"], 1)
        self.assertEqual(blocks["C2"]["raw_rank"], 2)

    def test_override_raw_changes_effective_only(self):
        records = recs(self.data)
        first_id = records[0]["id"]
        a = analyze(records, {first_id: (True, "test reason")}, "judge")
        for block in a["contestants"]:
            for ib in block["items"]:
                for s in ib["scores"]:
                    if s["id"] == first_id:
                        self.assertTrue(s["use_raw"])
                        self.assertEqual(s["effective"], s["raw"])
                        self.assertNotEqual(s["effective"], s["calibrated"])
                        self.assertEqual(s["reason"], "test reason")
                    else:
                        self.assertFalse(s["use_raw"])
                        self.assertEqual(s["effective"], s["calibrated"])
        # calibrated totals/ranks must be unaffected by decisions
        blocks = {b["contestant"]: b for b in a["contestants"]}
        self.assertEqual(blocks["C1"]["cal_rank"], 1)
        self.assertEqual(a["counts"]["decisions"], 1)

    def test_judge_item_scope(self):
        a = analyze(recs(self.data), {}, "judge_item")
        self.assertEqual(a["scope"], "judge_item")
        # 2 judges x 2 items = 4 groups
        self.assertEqual(len(a["groups"]), 4)
        self.assertIn("item", a["groups"][0])

    def test_reversal_detected(self):
        # Two tight judges rank C1 first; one wide-spread judge ranks C2 far
        # above C1. Raw average crowns C2; robust calibration downweights the
        # wide judge and crowns C1.
        data = [
            ("C1", "JA", "I1", 8.30), ("C2", "JA", "I1", 8.00),
            ("C3", "JA", "I1", 7.90), ("C4", "JA", "I1", 7.80),
            ("C1", "JB", "I1", 8.30), ("C2", "JB", "I1", 8.00),
            ("C3", "JB", "I1", 7.85), ("C4", "JB", "I1", 7.75),
            ("C1", "JC", "I1", 5.0), ("C2", "JC", "I1", 9.5),
            ("C3", "JC", "I1", 7.2), ("C4", "JC", "I1", 6.8),
        ]
        a = analyze(recs(data), {}, "judge")
        self.assertGreaterEqual(len(a["reversals"]), 1)
        top_reversal = a["reversals"][0]
        self.assertEqual(top_reversal["winner_before"], "C2")
        self.assertEqual(top_reversal["winner_after"], "C1")
        blocks = {b["contestant"]: b for b in a["contestants"]}
        self.assertEqual(blocks["C1"]["cal_rank"], 1)
        self.assertEqual(blocks["C2"]["raw_rank"], 1)

    def test_empty(self):
        a = analyze([], {}, "judge")
        self.assertEqual(a["counts"]["scores"], 0)
        self.assertEqual(a["reversals"], [])
        self.assertEqual(a["contestants"], [])

    def test_bad_scope(self):
        with self.assertRaises(ValueError):
            analyze(recs(self.data), {}, "bogus")


class TestStabilityExperiment(unittest.TestCase):
    def setUp(self):
        # 4 contestants x 3 judges x 1 item; JC is a wild outlier judge.
        data = [
            ("C1", "JA", "P1", 8.30), ("C2", "JA", "P1", 8.00),
            ("C3", "JA", "P1", 7.90), ("C4", "JA", "P1", 7.80),
            ("C1", "JB", "P1", 8.30), ("C2", "JB", "P1", 8.00),
            ("C3", "JB", "P1", 7.85), ("C4", "JB", "P1", 7.75),
            ("C1", "JC", "P1", 5.0), ("C2", "JC", "P1", 9.5),
            ("C3", "JC", "P1", 7.2), ("C4", "JC", "P1", 6.8),
        ]
        self.records = recs(data)
        # Add a second item so item exclusion leaves partial data.
        self.records += recs([
            ("C1", "JA", "P2", 8.2), ("C2", "JA", "P2", 8.1),
            ("C3", "JA", "P2", 7.8), ("C4", "JA", "P2", 7.7),
            ("C1", "JB", "P2", 8.1), ("C2", "JB", "P2", 8.0),
            ("C3", "JB", "P2", 7.9), ("C4", "JB", "P2", 7.8),
        ])

    def test_exclude_judge_baseline_fields(self):
        res = stability_experiment(self.records, {}, "judge", "judge", "JC")
        self.assertEqual(res["exclusion"]["type"], "judge")
        self.assertEqual(res["exclusion"]["name"], "JC")
        self.assertEqual(res["removed_scores"], 4)
        self.assertEqual(res["baseline_counts"]["scores"], 20)
        self.assertEqual(res["scenario_counts"]["scores"], 16)
        self.assertEqual(res["scenario_counts"]["judges"], 2)
        # Every contestant loses exactly one score (JC's).
        self.assertTrue(all(r["affected_scores"] == 1 for r in res["contestants"]))

    def test_deltas_match_independent_rerun(self):
        baseline = analyze(self.records, {}, "judge")
        res = stability_experiment(self.records, {}, "judge", "judge", "JC")
        kept = [r for r in self.records if r["judge"] != "JC"]
        scenario = analyze(kept, {}, "judge")

        b_map = {b["contestant"]: b for b in baseline["contestants"]}
        s_map = {b["contestant"]: b for b in scenario["contestants"]}
        self.assertEqual(len(res["contestants"]), len(baseline["contestants"]))
        for row in res["contestants"]:
            name = row["contestant"]
            self.assertTrue(row["present"])
            self.assertAlmostEqual(
                row["raw_total_delta"],
                s_map[name]["raw_total"] - b_map[name]["raw_total"],
            )
            self.assertEqual(
                row["eff_rank_delta"],
                b_map[name]["eff_rank"] - s_map[name]["eff_rank"],
            )
            self.assertEqual(row["baseline"]["eff_rank"], b_map[name]["eff_rank"])
            self.assertEqual(row["scenario"]["eff_rank"], s_map[name]["eff_rank"])

    def test_excluding_outlier_judge_changes_rank(self):
        # With JC removed the raw ranking must lose the reversal (C1 leads C2).
        res = stability_experiment(self.records, {}, "judge", "judge", "JC")
        rows = {r["contestant"]: r for r in res["contestants"]}
        # JC gives C2 9.5 vs C1 5.0 -> removing it moves C1 up / C2 down.
        self.assertGreaterEqual(rows["C1"]["raw_rank_delta"], 0)
        self.assertLess(rows["C2"]["raw_rank_delta"], 0)
        self.assertEqual(res["summary"]["eff_moved_up"] + res["summary"]["eff_moved_down"],
                         res["summary"]["eff_rank_changed"])

    def test_exclude_item_leaves_partial_data(self):
        res = stability_experiment(self.records, {}, "judge_item", "item", "P1")
        self.assertEqual(res["exclusion"]["type_label"], "项目")
        self.assertEqual(res["removed_scores"], 12)
        self.assertEqual(res["scenario_counts"]["items"], 1)
        # Everyone still scored P2, so all remain present.
        self.assertTrue(all(r["present"] for r in res["contestants"]))
        # Baseline totals contain two items, scenario only P2.
        for row in res["contestants"]:
            self.assertNotAlmostEqual(
                row["scenario"]["eff_total"], row["baseline"]["eff_total"]
            )

    def test_excluded_only_contestant_goes_missing(self):
        # C1 is only ever scored by judge JA -> removing JA removes C1 entirely.
        data = [
            ("C1", "JA", "P1", 9.0),
            ("C2", "JA", "P1", 7.0), ("C2", "JB", "P1", 6.0),
        ]
        records = recs(data)
        res = stability_experiment(records, {}, "judge", "judge", "JA")
        rows = {r["contestant"]: r for r in res["contestants"]}
        self.assertFalse(rows["C1"]["present"])
        self.assertIsNone(rows["C1"]["scenario"])
        self.assertIsNone(rows["C1"]["eff_rank_delta"])
        self.assertEqual(rows["C1"]["affected_scores"], 1)
        self.assertTrue(rows["C2"]["present"])
        self.assertEqual(rows["C2"]["affected_scores"], 1)

    def test_inputs_not_mutated_and_decisions_follow_removed_scores(self):
        records = recs([
            ("C1", "JA", "P1", 8.0), ("C2", "JA", "P1", 7.0),
            ("C1", "JB", "P1", 9.0), ("C2", "JB", "P1", 6.0),
        ])
        before = [dict(r) for r in records]
        decisions = {1: (True, "keep")}  # id 1 belongs to judge JA
        res = stability_experiment(records, decisions, "judge", "judge", "JB")
        self.assertEqual(records, before)
        self.assertEqual(len(decisions), 1)
        # JB excluded: its two scores are gone, JA's decision stays in effect.
        self.assertEqual(res["removed_scores"], 2)
        self.assertEqual(res["scenario_counts"]["decisions"], 1)

    def test_unknown_exclusion(self):
        with self.assertRaises(LookupError):
            stability_experiment(self.records, {}, "judge", "judge", "NOBODY")
        with self.assertRaises(ValueError):
            stability_experiment(self.records, {}, "judge", "round", "P1")


class TestCompareContestants(unittest.TestCase):
    def setUp(self):
        # 2 contestants x 2 judges x 2 items; JA low/tight, JB high/wide.
        self.data = [
            ("C1", "JA", "I1", 8.0),
            ("C2", "JA", "I1", 7.0),
            ("C1", "JA", "I2", 9.0),
            ("C2", "JA", "I2", 6.0),
            ("C1", "JB", "I1", 12.0),
            ("C2", "JB", "I1", 10.0),
            ("C1", "JB", "I2", 13.0),
            ("C2", "JB", "I2", 9.0),
        ]

    def test_totals_and_item_gaps(self):
        a = analyze(recs(self.data), {}, "judge")
        cmp = compare_contestants(a, "C1", "C2")
        blocks = {b["contestant"]: b for b in a["contestants"]}

        self.assertEqual(cmp["a"]["contestant"], "C1")
        self.assertEqual(cmp["b"]["contestant"], "C2")
        self.assertEqual(len(cmp["items"]), 2)

        # C1 wins both items in every kind: 2 leads / 0 ties / 0 no-data.
        for kind in ("raw", "cal", "eff"):
            st = cmp["summary"][kind]
            self.assertEqual((st["a_leads"], st["b_leads"], st["ties"], st["no_data"]),
                             (2, 0, 0, 0))
            t = cmp["totals"][kind]
            self.assertAlmostEqual(t["a"], blocks["C1"][f"{kind}_total"])
            self.assertAlmostEqual(t["b"], blocks["C2"][f"{kind}_total"])
            self.assertAlmostEqual(t["diff"],
                                   blocks["C1"][f"{kind}_total"] - blocks["C2"][f"{kind}_total"])
            self.assertEqual(t["leader"], "a")
            self.assertEqual(t["a_rank"], blocks["C1"][f"{kind}_rank"])

        # Item rows carry per-kind values/gaps matching the analysis blocks.
        i1 = next(r for r in cmp["items"] if r["item"] == "I1")
        c2_i1 = next(ib for ib in blocks["C2"]["items"] if ib["item"] == "I1")
        self.assertAlmostEqual(i1["b_raw"], c2_i1["raw_avg"])
        self.assertAlmostEqual(i1["raw_diff"],
                               next(ib for ib in blocks["C1"]["items"] if ib["item"] == "I1")["raw_avg"]
                               - c2_i1["raw_avg"])
        self.assertEqual(i1["raw_leader"], "a")
        self.assertTrue(i1["a_present"] and i1["b_present"])
        self.assertEqual(i1["a_n_scores"], 2)

    def test_missing_item_is_no_data_not_zero(self):
        # C2 has no scores at all for I2.
        data = [r for r in self.data if not (r[0] == "C2" and r[2] == "I2")]
        a = analyze(recs(data), {}, "judge")
        cmp = compare_contestants(a, "C1", "C2")

        i2 = next(r for r in cmp["items"] if r["item"] == "I2")
        self.assertTrue(i2["a_present"])
        self.assertFalse(i2["b_present"])
        self.assertEqual(i2["b_n_scores"], 0)
        for kind in ("raw", "cal", "eff"):
            self.assertIsNotNone(i2[f"a_{kind}"])
            self.assertIsNone(i2[f"b_{kind}"])
            self.assertIsNone(i2[f"{kind}_diff"])
            self.assertEqual(i2[f"{kind}_leader"], "none")
            # I1 still comparable; I2 excluded from win/tie stats.
            st = cmp["summary"][kind]
            self.assertEqual((st["a_leads"], st["b_leads"], st["ties"], st["no_data"]),
                             (1, 0, 0, 1))

        # Totals remain independently computed (C2's total sums only I1).
        blocks = {b["contestant"]: b for b in a["contestants"]}
        self.assertAlmostEqual(cmp["totals"]["raw"]["b"], blocks["C2"]["raw_total"])
        # I1 alone is smaller than C1's two-item total; the gap is still judged.
        self.assertEqual(cmp["totals"]["raw"]["leader"], "a")

    def test_reverse_order_flips_direction(self):
        a = analyze(recs(self.data), {}, "judge")
        cmp = compare_contestants(a, "C2", "C1")
        self.assertEqual(cmp["totals"]["raw"]["leader"], "b")
        self.assertAlmostEqual(
            cmp["totals"]["raw"]["diff"],
            -compare_contestants(a, "C1", "C2")["totals"]["raw"]["diff"],
        )
        i1 = next(r for r in cmp["items"] if r["item"] == "I1")
        self.assertEqual(i1["raw_leader"], "b")
        self.assertEqual(cmp["summary"]["raw"]["b_leads"], 2)

    def test_exact_item_tie_counts_as_tie(self):
        # Equal averages on I1, different on I2.
        data = [
            ("C1", "JA", "I1", 8.0), ("C2", "JA", "I1", 8.0),
            ("C1", "JB", "I1", 10.0), ("C2", "JB", "I1", 10.0),
            ("C1", "JA", "I2", 9.0), ("C2", "JA", "I2", 6.0),
            ("C1", "JB", "I2", 11.0), ("C2", "JB", "I2", 9.0),
        ]
        a = analyze(recs(data), {}, "judge")
        cmp = compare_contestants(a, "C1", "C2")
        i1 = next(r for r in cmp["items"] if r["item"] == "I1")
        self.assertEqual(i1["raw_leader"], "tie")
        self.assertEqual(i1["raw_diff"], 0.0)
        st = cmp["summary"]["raw"]
        self.assertEqual((st["a_leads"], st["ties"]), (1, 1))

    def test_effective_gap_follows_decisions(self):
        # Overriding all of C1's scores to raw only changes the "eff" comparison.
        records = recs(self.data)
        decisions = {
            r["id"]: (True, "keep raw")
            for r in records if r["contestant"] == "C1"
        }
        a = analyze(records, decisions, "judge")
        cmp = compare_contestants(a, "C1", "C2")
        blocks = {b["contestant"]: b for b in a["contestants"]}
        self.assertAlmostEqual(cmp["totals"]["eff"]["a"], blocks["C1"]["eff_total"])
        self.assertAlmostEqual(cmp["totals"]["eff"]["b"], blocks["C2"]["eff_total"])
        # Effective column equals raw column for C1's item rows.
        i1 = next(r for r in cmp["items"] if r["item"] == "I1")
        self.assertAlmostEqual(i1["a_eff"], i1["a_raw"])
        # Raw/cal columns are unaffected by decisions.
        self.assertAlmostEqual(cmp["totals"]["raw"]["a"], blocks["C1"]["raw_total"])

    def test_scope_label_propagates(self):
        a = analyze(recs(self.data), {}, "judge_item")
        cmp = compare_contestants(a, "C1", "C2")
        self.assertEqual(cmp["scope"], "judge_item")
        self.assertIn(cmp["scope_label"], (a["scope_label"],))
        self.assertEqual(set(cmp["kind_labels"]), {"raw", "cal", "eff"})

    def test_errors(self):
        a = analyze(recs(self.data), {}, "judge")
        with self.assertRaises(LookupError):
            compare_contestants(a, "C1", "NOBODY")
        with self.assertRaises(LookupError):
            compare_contestants(a, "GHOST", "C1")
        with self.assertRaises(ValueError):
            compare_contestants(a, "C1", "C1")


if __name__ == "__main__":
    unittest.main()
