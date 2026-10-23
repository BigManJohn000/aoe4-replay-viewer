import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import convert
import recfile
import rlog


def entity(**kwargs):
    fields = dict(id=1, owner=1, bp='building_test', maxhp=1000, building=True, squad=0,
                  spans=[[0, None]], track=[0, 10, 20, 1000])
    fields.update(kwargs)
    return convert.Ent(**fields)


class ConvertTests(unittest.TestCase):
    def test_damage_after_three_seconds_without_changes(self):
        e = entity(track=[0, 10, 20, 1000, 3, 10, 20, 400])
        fights = convert.detect_fights(SimpleNamespace(ents=[e], attacks=[]), {}, 400)
        self.assertEqual(len(fights), 1)
        self.assertEqual(fights[0]['start'], 3)
        self.assertEqual(fights[0]['damage'], 600)

    def test_damage_at_span_reentry_is_not_combat(self):
        e = entity(spans=[[0, 0.25], [0.5, None]], track=[0, 10, 20, 1000, 0.5, 10, 20, 400])
        self.assertEqual(convert.detect_fights(SimpleNamespace(ents=[e], attacks=[]), {}, 400), [])

    def test_damage_after_reentry_is_combat(self):
        e = entity(spans=[[0, 1], [3, None]],
                   track=[0, 10, 20, 1000, 3, 10, 20, 900, 3.5, 10, 20, 300])
        fights = convert.detect_fights(SimpleNamespace(ents=[e], attacks=[]), {}, 400)
        self.assertEqual(len(fights), 1)
        self.assertEqual(fights[0]['damage'], 600)
        self.assertEqual(fights[0]['start'], 3.5)

    def test_alive_spans_are_half_open(self):
        e = entity(spans=[[1, 3], [5, None]])
        self.assertFalse(e.alive_at(0))
        self.assertTrue(e.alive_at(1))
        self.assertTrue(e.alive_at(2.999))
        self.assertFalse(e.alive_at(3))
        self.assertFalse(e.alive_at(4))
        self.assertTrue(e.alive_at(5))
        self.assertTrue(e.alive_at(100))

    def test_conversion_cast_excludes_caster_at_span_end(self):
        e = entity(spans=[[0, 3]])
        ability = recfile.AbilityUse(24, 1, 192685, [e.id], False, None)
        replay = SimpleNamespace(abilities=lambda: [ability])
        self.assertEqual(convert.conversion_casts(replay, SimpleNamespace(ents=[e])), [])

    def test_upgrade_uses_owner_at_research_time_and_counts_unknown(self):
        e = entity(owners=[[0, 1], [5, 2]])
        log = SimpleNamespace(upgrades=[
            {'t': 6, 'fields': {'upgrade': 'sfeudal_age', 'executer': 'e1'}},
            {'t': 4, 'fields': {'upgrade': 'scastle_age', 'executer': 'e1'}},
            {'t': 7, 'fields': {'upgrade': 'simperial_age', 'executer': 'e999'}},
        ])
        rows, missing = convert.tech_list(log, {e.id: e})
        self.assertEqual(rows, [[4, 1, 'Castle Age', 'age'], [6, 2, 'Feudal Age', 'age']])
        self.assertEqual(missing, 1)

    def test_olive_oil_mercenary_cost(self):
        e = entity()
        costs = {(e.owner, e.bp): [{'t': float('-inf'), 'squad': 3,
                                  'cost': rlog.cost_values('merc_byz=240,action=1')}]}
        self.assertEqual(convert.entity_value(e, costs), 80)
        self.assertNotIn('merc_byz', convert.RESOURCES)

    def test_write_index_preserves_two_line_format(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data, notes = root / 'data', root / 'notes'
            data.mkdir()
            notes.mkdir()
            for name in ('zebra.js', 'alpha.js', 'index.js'):
                (data / name).touch()
            (notes / 'zebra.js').touch()
            with patch.object(convert, 'DATA_DIR', data):
                convert.write_index()
            self.assertEqual((data / 'index.js').read_text(encoding='utf-8'),
                             'window.REPLAY_INDEX = ["alpha", "zebra"];\n'
                             'window.REPLAY_NOTED = ["zebra"];\n')

    def parse(self, lines):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'test.rlog'
            path.write_text('HDR|5|1|100|100|2\n' + '\n'.join(lines) + '\n', encoding='utf-8')
            return convert.parse_rlog(path)

    def test_live_new_record_resynchronizes_without_new_lifetime(self):
        log = self.parse(['N|1|7,1,unit_test,100,0,0,10,20,100',
                          'N|2|7,2,unit_test,100,0,0,11,22,90',
                          'N|3|7,2,unit_test,100,0,0,12,23,80'])
        self.assertEqual(len(log.ents), 1)
        e = log.ents[0]
        self.assertEqual(e.spans, [[1, None]])
        self.assertEqual(e.owners, [[1, 1], [2, 2]])
        self.assertEqual(e.track, [1, 10, 20, 100, 2, 11, 22, 90, 3, 12, 23, 80])

    def test_v5_quote_selection_is_sorted_and_uses_first_birth(self):
        log = self.parse(['B|1|unit_test|2|food=100,wood=50|5',
                          'B|1|unit_test|2|food=200,wood=100|1',
                          'N|2|7,1,unit_test,100,0,0,10,20,100',
                          'X|3|7', 'N|6|7,1,unit_test,100,0,0,10,20,100',
                          'N|5|8,1,unit_test,100,0,0,10,20,100'])
        first, second = log.ents
        self.assertEqual(convert.entity_value(first, log.costs), 150)
        self.assertEqual(convert.entity_cost(first, log.costs), [100, 50, 0, 0])
        self.assertEqual(convert.entity_value(second, log.costs), 75)
        self.assertEqual(convert.entity_cost(second, log.costs), [50, 25, 0, 0])

    def test_no_quote_before_birth_is_null(self):
        log = self.parse(['N|1|7,1,unit_test,100,0,0,10,20,100', 'B|1|unit_test|0|gold=50|2'])
        self.assertIsNone(convert.entity_cost(log.ents[0], log.costs))
        self.assertEqual(convert.entity_value(log.ents[0], log.costs), 0)

    def test_v4_quote_retains_last_timeless_value(self):
        log = self.parse(['B|1|unit_test|0|food=100', 'N|1|7,1,unit_test,100,0,0,10,20,100',
                          'B|1|unit_test|0|food=80'])
        self.assertEqual(convert.entity_value(log.ents[0], log.costs), 80)
        self.assertEqual(convert.entity_cost(log.ents[0], log.costs), [80, 0, 0, 0])

    def test_v4_and_v5_cost_grammar(self):
        old, new = [r for _, r in rlog.records(['B|1|unit_test|2|food=100',
                                                'B|1|unit_test|2|food=80|3.5\n'])]
        self.assertEqual(old.t, float('-inf'))
        self.assertEqual(new.t, 3.5)
        self.assertEqual(old[:4], (1, 'unit_test', 2, 'food=100'))
        self.assertEqual(new[:4], (1, 'unit_test', 2, 'food=80'))

    def test_payload_validation_rejects_truncated_assignment(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'test.js'
            path.write_text('(window.REPLAY_DATA = window.REPLAY_DATA || {})["test"] = {"format":1', encoding='utf-8')
            self.assertFalse(convert.payload_valid(path))


if __name__ == '__main__':
    unittest.main()
