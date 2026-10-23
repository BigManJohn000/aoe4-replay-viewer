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
        costs = {(e.owner, e.bp): {'squad': 3, 'cost': rlog.cost_values('merc_byz=240,action=1')}}
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


if __name__ == '__main__':
    unittest.main()
