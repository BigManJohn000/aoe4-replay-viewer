import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recfile


def command(ctype, receiver_bytes, dtype=0xff, data=b'', queued=False):
    header = bytearray(24)
    header[2:4] = bytes((ctype, 3 | (0x80 if queued else 0)))
    struct.pack_into('<I', header, 4, 12345)
    payload = receiver_bytes + bytes((dtype,))
    if dtype != 0xff:
        payload += bytes((len(data),)) + data
    result = header + payload
    struct.pack_into('<H', result, 0, len(result))
    return bytes(result)


class RecfileTests(unittest.TestCase):
    def decode(self, commands, method):
        replay = recfile.Replay(Path('synthetic.rec'), b'', 0, '', [], 0)
        with patch.object(recfile.Replay, 'ticks', return_value=iter([recfile.Tick(80, [(7, b''.join(commands))])])):
            return list(getattr(replay, method)())

    def test_short_command(self):
        for method in ('commands', 'cameras', 'abilities', 'orders'):
            with self.subTest(method=method):
                self.assertEqual(self.decode([b'\x02\x00'], method), [])

    def test_orders_single_entity_queued_position(self):
        c = command(0x07, struct.pack('>I', 0x10000023), 1,
                    b'\x02' + struct.pack('<fff', 12.5, 9, -7.25), queued=True)
        self.assertEqual(recfile.receivers(c), [(1, 0x23)])
        self.assertEqual(self.decode([c], 'orders'), [(80, 3, 0x07, True, 1, 'entity', (12.5, -7.25))])

    def test_orders_squad_receiver_array(self):
        c = command(0x43, b'\x42' + struct.pack('<II', 0x20000001, 0x20000002), 1,
                    b'\x03' + struct.pack('<I', recfile.ENTITY_ID_BASE + 42))
        self.assertEqual(recfile.receivers(c), [(2, 1), (2, 2)])
        self.assertEqual(self.decode([c], 'orders'), [(80, 3, 0x43, False, 2, 'squad', None)])

    def test_orders_large_receiver_array_and_unknown_type(self):
        c = command(0xfe, b'\x80\x40' + struct.pack('<64I', *[0x20000000 + i for i in range(64)]))
        self.assertEqual(self.decode([c], 'orders'), [(80, 3, 0xfe, False, 64, 'squad', None)])

    def test_orders_empty_receivers(self):
        c = command(0x92, b'\x40')
        self.assertEqual(self.decode([c], 'orders'), [(80, 3, 0x92, False, 0, None, None)])

    def test_orders_verified_target_offsets(self):
        target = b'\x02' + struct.pack('<fff', -14, 4, 32)
        for dtype, data in ((3, target + bytes(17)), (6, bytes(4) + target),
                            (30, target + bytes(29)), (37, bytes(10) + target),
                            (42, bytes(6) + target + bytes(17)),
                            (27, b'\x01' + bytes(4) + struct.pack('<fff', -14, 4, 32))):
            with self.subTest(dtype=dtype):
                c = command(0x48, struct.pack('>I', 0x20000001), dtype, data)
                self.assertEqual(self.decode([c], 'orders')[0][-1], (-14, 32))

    def test_ability_direction_target_uses_offset_six(self):
        data = b'\x01' + struct.pack('<I', 174067) + b'\x00\x02' + struct.pack('<fff', -116, 4.582, 40) + bytes(17)
        c = command(0x48, struct.pack('>I', 0x20000023), 42, data)
        casts = self.decode([c], 'abilities')
        self.assertEqual(len(casts), 1)
        self.assertEqual(casts[0].target, ('pos', -116, 40))
        self.assertEqual(casts[0].casters, [recfile.SQUAD_ID_BASE + 0x23])
        self.assertEqual(casts[0].pbgid, 174067)


if __name__ == '__main__':
    unittest.main()
