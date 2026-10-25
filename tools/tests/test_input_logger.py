import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import input_logger as il

KEY_1, KEY_2, KEY_H, KEY_A = 0x31, 0x32, 0x48, 0x41


def press(t, vk, mods=0):
    return [["k", t, vk, 1, mods], ["k", t + 30, vk, 0, mods]]


class ActionTests(unittest.TestCase):
    def test_control_groups_assign_add_recall_and_double_tap(self):
        events = (press(0, KEY_1, il.CTRL) + press(100, KEY_1, il.SHIFT) + press(1000, KEY_1) + press(1400, KEY_1)
                  + press(1700, KEY_1) + press(3000, KEY_2) + press(3600, KEY_2)
                  + press(5000, KEY_2) + press(5100, KEY_H) + press(5200, KEY_2))
        kinds = [(a.kind, a.key) for a in il.actions(events)]
        self.assertEqual(kinds, [
            ("assign", 1), ("add", 1), ("recall", 1), ("double", 1), ("recall", 1),  # a third tap starts over
            ("recall", 2), ("recall", 2),  # 600 ms apart
            ("recall", 2), ("key", KEY_H), ("recall", 2),  # another key in between
        ])

    def test_clicks_are_placed_on_the_game_window_and_outside_input_dropped(self):
        events = [["g", 0, 100, 50, 800, 400],
                  ["m", 10, "L", 1, 100, 50, 0], ["m", 20, "L", 0, 500, 250, 0],  # box from the top-left corner
                  ["m", 30, "R", 1, 899, 449, 0], ["m", 31, "R", 0, 899, 449, 0],  # bottom-right pixel
                  ["m", 40, "R", 1, 50, 60, 0],  # left of the window
                  ["m", 50, "R", 1, 300, 100, il.INJECTED]]
        acts = il.actions(events)
        self.assertEqual([a.kind for a in acts], ["click", "right"])
        box, right = acts
        self.assertEqual((box.x, box.y, box.x1, box.y1), (-1.0, 1.0, 0.0, 0.0))
        self.assertEqual(box.pixel, (0, 0))
        self.assertAlmostEqual(right.x, 1 - 2 / 800)
        self.assertAlmostEqual(right.y, -1 + 2 / 400)
        self.assertEqual(right.aspect, 2.0)

    def test_a_click_is_ordered_by_its_press(self):
        events = [["g", 0, 0, 0, 100, 100], ["m", 10, "L", 1, 5, 5, 0]] + press(20, KEY_H) + [["m", 40, "L", 0, 5, 5, 0]]
        self.assertEqual([a.kind for a in il.actions(events)], ["click", "key"])


class KBD:
    def __init__(self, vk, injected=False):
        self.vkCode, self.flags, self.time = vk, il.LLKHF_INJECTED if injected else 0, 1000


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.rec = il.Recorder(Path("unused.jsonl"), "game.exe", None)
        self.rec.game_window = lambda: 1
        patcher = patch.object(il, "modifiers", return_value=0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def type(self, *vks):
        for vk in vks:
            self.rec.on_key(il.WM_KEYDOWN, KBD(vk))
            self.rec.on_key(il.WM_KEYUP, KBD(vk))

    def keys_written(self):
        return [line[2] for line in self.rec.queue if line[0] == "k" and line[3]]

    def test_chat_between_enter_and_enter_or_escape_is_not_written(self):
        self.type(KEY_H, il.VK_RETURN, KEY_H, KEY_A, il.VK_RETURN, KEY_1, il.VK_RETURN, KEY_A, il.VK_ESCAPE, KEY_2)
        self.assertEqual(self.keys_written(), [KEY_H, KEY_1, KEY_2])
        self.assertEqual([line[2] for line in self.rec.queue if line[0] == "c"], [1, 0, 1, 0])

    def test_a_replay_saved_while_chat_is_open_does_not_end_the_chat(self):
        with tempfile.TemporaryDirectory() as tmp:
            playback = Path(tmp) / "temp.rec"
            self.rec.path, self.rec.playback = Path(tmp) / "log.jsonl", playback
            seen, pending = self.rec.poll_replay(None, None)
            self.type(il.VK_RETURN)
            playback.write_bytes(b"replay")
            seen, pending = self.rec.poll_replay(seen, pending)  # changed: wait for it to settle
            seen, pending = self.rec.poll_replay(seen, pending)  # settled: copied
            saved = [line[2] for line in self.rec.queue if line[0] == "r"]
            self.assertEqual(len(saved), 1)
            self.assertEqual((Path(tmp) / saved[0]).read_bytes(), b"replay")
        self.type(KEY_H, KEY_A, il.VK_RETURN, KEY_1)
        self.assertEqual(self.keys_written(), [KEY_1])

    def test_key_repeat_is_written_once(self):
        for _ in range(3):
            self.rec.on_key(il.WM_KEYDOWN, KBD(KEY_H))
        self.rec.on_key(il.WM_KEYUP, KBD(KEY_H))
        self.assertEqual([line[3] for line in self.rec.queue if line[0] == "k"], [1, 0])

    def test_nothing_is_written_while_another_window_is_active(self):
        self.rec.game_window = lambda: None
        self.type(KEY_H)
        self.rec.on_mouse(0x201, None)
        self.assertEqual(self.rec.queue, [])


if __name__ == "__main__":
    unittest.main()
