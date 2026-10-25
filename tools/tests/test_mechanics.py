import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mechanics


def order(tick, *receivers):
    return mechanics.Order(tick, frozenset(("s", r) for r in receivers), frozenset({0x3E}))


class GroundViewTests(unittest.TestCase):
    def test_camera_looking_straight_down_sees_screen_shaped_rectangle(self):
        # +z rotated 90 degrees about +x looks along -y; the screen's up is then +z and its right +x
        down = (math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0)
        poly = mechanics.ground_view((10.0, 50.0, -20.0), down, 40.0)
        half_z = 50 * math.tan(math.radians(20))
        half_x = half_z * mechanics.ASPECT
        expected = [(10 - half_x, -20 - half_z), (10 + half_x, -20 - half_z),
                    (10 + half_x, -20 + half_z), (10 - half_x, -20 + half_z)]
        for got, want in zip(poly, expected):
            self.assertAlmostEqual(got[0], want[0], places=6)
            self.assertAlmostEqual(got[1], want[1], places=6)

    def test_view_meets_the_terrain_under_its_centre(self):
        down = (math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0)
        poly = mechanics.ground_view((0.0, 50.0, 0.0), down, 40.0, height=lambda x, z: 30.0)
        self.assertAlmostEqual(poly[2][1], 20 * math.tan(math.radians(20)), places=6)

    def test_screen_point_lands_under_its_pixel(self):
        down = (math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0)
        half_z = 50 * math.tan(math.radians(20))
        half_x = half_z * 2.0
        x, z = mechanics.ground_point((10.0, 50.0, -20.0), down, 40.0, 1.0, 1.0, aspect=2.0)
        self.assertAlmostEqual(x, 10 + half_x, places=6)
        self.assertAlmostEqual(z, -20 + half_z, places=6)
        x, z = mechanics.ground_point((10.0, 50.0, -20.0), down, 40.0, -0.5, 0.0, aspect=2.0)
        self.assertAlmostEqual(x, 10 - half_x / 2, places=6)
        self.assertAlmostEqual(z, -20, places=6)

    def test_screen_point_follows_sloping_terrain(self):
        # 45 degrees down from (0, 50, 0) onto y = 0.1 z: 50 - z = 0.1 z
        tilted = (math.cos(math.pi / 8), math.sin(math.pi / 8), 0.0, 0.0)
        x, z = mechanics.ground_point((0.0, 50.0, 0.0), tilted, 40.0, 0.0, 0.0, height=lambda x, z: 0.1 * z)
        self.assertAlmostEqual(x, 0.0, places=6)
        self.assertAlmostEqual(z, 50 / 1.1, delta=0.01)

    def test_outside_distance_for_either_winding(self):
        square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
        for poly in (square, square[::-1]):
            self.assertAlmostEqual(mechanics.outside(poly, 5, 5), -5.0)
            self.assertAlmostEqual(mechanics.outside(poly, 15, 5), 5.0)
            self.assertAlmostEqual(mechanics.outside(poly, 5, -3), 3.0)


class SelectionTests(unittest.TestCase):
    def test_new_selections_and_recalls(self):
        orders = [order(1, 1, 2), order(2, 1, 2), order(3, 3), order(4, 1, 2), order(5, 1), order(6, 3), order(7, 4)]
        # 1 repeats 0; 4 is part of 3's selection; 5 repeats a single receiver, no recall
        self.assertEqual(mechanics.selections(orders), [(0, False), (2, False), (3, True), (5, False), (6, False)])

    def test_the_whole_selection_after_an_order_to_part_of_it_is_not_new(self):
        orders = [order(1, 1, 2, 3), order(2, 1), order(3, 1, 2, 3)]
        self.assertEqual(mechanics.selections(orders), [(0, False)])


if __name__ == '__main__':
    unittest.main()
