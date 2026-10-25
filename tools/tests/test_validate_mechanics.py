import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import validate_mechanics as vm
from input_logger import Action


def busy_game(seed=1, seconds=1500, rate=1.5):
    """Order times (seconds) of a player issuing `rate` orders a second, on whole ticks."""
    rnd = random.Random(seed)
    return sorted({round(rnd.uniform(0, seconds) * 8) / 8 for _ in range(int(seconds * rate))})


class AlignTests(unittest.TestCase):
    def test_finds_the_offset_and_the_pause(self):
        rnd = random.Random(2)
        orders = busy_game()
        # the log started 70 s before the game; a 40 s pause at game second 800 delays later input
        clicks = sorted(o - 0.4 + rnd.uniform(-0.1, 0.1) + 70 + (40 if o > 800 else 0)
                        for o in orders if rnd.random() < 0.6)
        clock = vm.align(clicks, orders)
        self.assertEqual(len(clock.pieces), 2)
        (_, before), (start, after) = clock.pieces
        self.assertAlmostEqual(before, -69.6, delta=0.06)
        self.assertAlmostEqual(after, -109.6, delta=0.06)
        self.assertGreater(clock.paired / clock.clicks, 0.95)
        gap = max(r for r in clicks if r < 800 + 70), min(r for r in clicks if r > 800 + 110 - 1)
        self.assertTrue(gap[0] <= start <= gap[1])  # either side of the pause is right
        for g in (100.0, 1200.0):
            self.assertAlmostEqual(clock.game(clock.log(g)), g)

    def test_unrelated_clicks_do_not_line_up(self):
        rnd = random.Random(3)
        orders = busy_game(rate=0.3)
        clicks = sorted(rnd.uniform(0, 1500) for _ in range(300))
        self.assertIsNone(vm.align(clicks, orders))


def click(t, on=False):
    return Action(t, "click", x=0.0, y=0.0, x1=0.0, y1=0.0, pixel=(1 if on else 0, 0))


def key(t, vk):
    return Action(t, "key", vk)


ON = lambda a: a.pixel[0] == 1  # noqa: E731


class SelectionInputTests(unittest.TestCase):
    def test_the_newest_click_on_the_receivers_or_group_recall_decides(self):
        recall = Action(0, "recall", 1)
        self.assertEqual(vm.selection_input([recall, click(1)], ON)[0], "group")
        self.assertEqual(vm.selection_input([recall, click(1, on=True)], ON)[0], "click")
        self.assertEqual(vm.selection_input([click(0, on=True), recall], ON)[0], "group")

    def test_otherwise_the_oldest_input_tells_hotkey_from_hud(self):
        self.assertEqual(vm.selection_input([key(0, 0x48), click(1), key(2, 0x51)], ON), ("key", [0x48, 0x51]))
        self.assertEqual(vm.selection_input([click(0), key(1, 0x51)], ON)[0], "unclear")
        self.assertEqual(vm.selection_input([Action(0, "assign", 3)], ON)[0], "none")


class JumpCauseTests(unittest.TestCase):
    def test_the_newest_input_before_the_jump(self):
        minimap = lambda a: a.pixel[0] == 1  # noqa: E731
        self.assertEqual(vm.jump_cause([key(0, 0x48), Action(1, "double", 2)], minimap), ("double", 2))
        self.assertEqual(vm.jump_cause([Action(0, "double", 2), key(1, 0x48)], minimap), ("key", 0x48))
        self.assertEqual(vm.jump_cause([key(0, 0x48), click(1, on=True)], minimap), ("minimap", None))
        self.assertEqual(vm.jump_cause([click(1)], minimap), ("click", None))
        self.assertEqual(vm.jump_cause([Action(0, "recall", 1)], minimap), ("none", None))


if __name__ == "__main__":
    unittest.main()
