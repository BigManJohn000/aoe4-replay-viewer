import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('M-01/M-02/M-12/S-04: Python summary math, event ownership and content-addressed trends', () => {
  const result = spawnSync(path.join(ROOT, 'python/python.exe'), ['-c', String.raw`
import json, pathlib, sys, tempfile, unittest, zlib
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path.cwd()))
from tools import analyze_summaries as summaries, trends

class MathRegression(unittest.TestCase):
    def summary_rows(self, completion=500):
        key = 'upgrade_econ_resource_wood_harvest_rate_2'
        tech = dict(attribName=key, pbgid=1, name='Double Broadax', civs=['en'], costs={'wood':100,'gold':50},
                    effects=[dict(property='woodGatherRate',effect='multiply',value=1.15)])
        players = [dict(profileId=i,name=str(i),civilization='english',result='win' if i==1 else 'loss',
                        actions={'feudalAge':[100], **({key:[t]} if t is not None else {})},
                        resources={'timestamps':[0,1000],'woodPerMin':[600,600]}) for i,t in [(1,300),(2,completion)]]
        row = dict(game_id=1,p0=1,p1=2,p0_mmr=2000,p1_mmr=2000,duration=1000,
                   body=zlib.compress(json.dumps(dict(gameId=1,players=players)).encode()))
        data, _ = summaries.analyse([row],[tech],[])
        return next(r for r in data['records'] if r['profile_id']==2 and r['tech']=='double-broadax')

    def test_M01_missing_multiplier_is_not_divided_out(self):
        row = self.summary_rows()
        self.assertEqual(row['benchmark'],400)
        self.assertAlmostEqual(row['missed_gather'],150)

    def test_M02_paid_cost_cancels_but_skipped_cost_is_unspent(self):
        row = self.summary_rows()
        self.assertEqual(row['status'],'delayed')
        self.assertAlmostEqual(row['net_deficit'],150)
        skipped = self.summary_rows(None)
        self.assertEqual(skipped['status'],'skipped')
        self.assertAlmostEqual(skipped['net_deficit'],skipped['missed_gather']-150)

    def match(self):
        return dict(duration=600,replay={},army={'step':5,'players':{}},stats={},techs=[],
            players=[dict(idx=i,team=1 if i<3 else 2,name=str(i),civ='english') for i in range(1,5)],
            fights=[dict(start=20,participants=[1,2,3,4],losses={str(i):{'value':100} for i in range(1,5)})],
            entities=[dict(id=1,owner=1,owners=[[0,1],[100,3]],value=100),dict(id=2,owner=2,value=100),
                      dict(id=3,owner=3,value=100),dict(id=4,owner=4,value=100)],
            kills=[dict(t=50,killer=2,victim=3),dict(t=150,killer=1,victim=2),
                   dict(t=155,killer=1,victim=4),dict(t=160,killer=None,victim=4)])

    def test_M12_personal_kills_follow_hostile_owner_at_time(self):
        rows = trends.match_metrics(self.match())['players']
        self.assertEqual([p['killed'] for p in rows],[0,100,100,0])
        self.assertEqual(sum(p['killed'] for p in rows),200)

    def test_S04_trends_rejects_changed_engine_and_missing_or_unlisted_payloads(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); data = root/'viewer'/'data'; data.mkdir(parents=True)
            (root/'tools').mkdir()
            source = root/'tools'/'trends.py'; source.write_text(pathlib.Path(trends.__file__).read_text(encoding='utf-8'),encoding='utf-8')
            (root/'tools'/'fetch_replays.py').write_text('# dependency',encoding='utf-8')
            out = data/'trends'/'games.js'
            names = ['aoe4_123456','aoe4_234567','aoe4_345678']
            index = data/'index.js'
            index.write_text('window.REPLAY_INDEX = '+json.dumps(names)+';',encoding='utf-8')
            for name in names:
                (data/(name+'.js')).write_text('window.REPLAY_DATA["'+name+'"] = '+json.dumps(self.match())+';',encoding='utf-8')
            with patch.multiple(trends,ROOT=root,DATA_DIR=data,OUT=out,__file__=str(source)), patch.object(trends,'game_info',return_value={'players':[]}), patch.object(trends.time,'sleep'):
                trends.update()
                first = json.loads(out.read_text(encoding='utf-8')[len(trends.PREFIX):-2])
                self.assertEqual(len(first['matches']),3)
                with patch.object(trends,'match_metrics',wraps=trends.match_metrics) as metrics:
                    trends.update(); self.assertEqual(metrics.call_count,0)
                    source.write_text(source.read_text(encoding='utf-8')+'\n# changed engine\n',encoding='utf-8')
                    trends.update(); self.assertEqual(metrics.call_count,3)
                second = json.loads(out.read_text(encoding='utf-8')[len(trends.PREFIX):-2])
                self.assertNotEqual(first['engineHash'],second['engineHash'])
                (data/(names[1]+'.js')).unlink()
                index.write_text('window.REPLAY_INDEX = '+json.dumps(names[:2])+';',encoding='utf-8')
                trends.update()
                final = json.loads(out.read_text(encoding='utf-8')[len(trends.PREFIX):-2])
                self.assertEqual(list(final['matches']),names[:1])

unittest.main(argv=['math-regression'],verbosity=2)
`], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('S-04: analyser hashes engine and payload contents, and aggregates only indexed existing matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-analysis-'));
  try {
    for (const dir of ['tools', 'viewer/data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools/analyze_rlogs.mjs'), path.join(root, 'tools/analyze_rlogs.mjs'));
    for (const name of ['units', 'stats', 'frame', 'model', 'fights', 'eco']) fs.copyFileSync(path.join(ROOT, `viewer/${name}.js`), path.join(root, `viewer/${name}.js`));
    const names = ['aoe4_123456', 'aoe4_234567', 'aoe4_345678'];
    const data = { duration: 200, world: 100, recordStart: 0, capturedEnd: 200, replay: {},
      players: [{ idx: 1, name: 'A', civ: 'english', team: 1 }, { idx: 2, name: 'B', civ: 'english', team: 2 }],
      entities: [], fights: [], techs: [], upgrades: [], jobs: {}, stats: {}, army: { step: 5, players: {} } };
    const index = path.join(root, 'viewer/data/index.js');
    fs.writeFileSync(index, `window.REPLAY_INDEX = ${JSON.stringify(names)};`);
    for (const name of names) fs.writeFileSync(path.join(root, `viewer/data/${name}.js`), `window.REPLAY_DATA = {${JSON.stringify(name)}:${JSON.stringify(data)}};`);
    const run = (...args) => {
      const result = spawnSync(process.execPath, [path.join(root, 'tools/analyze_rlogs.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const record = name => JSON.parse(fs.readFileSync(path.join(root, `harvest/analysis/${name}.json`), 'utf8'));
    run(); const first = record(names[0]);
    assert.equal(record('aggregate').recordings.length, 3);
    assert.match(run(names[0]), /cached/);
    fs.appendFileSync(path.join(root, 'viewer/frame.js'), '\n// Changed engine source\n');
    run(names[0]); const changed = record(names[0]);
    assert.notEqual(first.engineHash, changed.engineHash);
    assert.deepEqual(record('aggregate').recordings.map(r => r.name), [names[0]]); // other engine caches are stale
    run();
    fs.unlinkSync(path.join(root, `viewer/data/${names[1]}.js`));
    fs.writeFileSync(index, `window.REPLAY_INDEX = ${JSON.stringify(names.slice(0, 2))};`);
    run(names[0]);
    assert.deepEqual(record('aggregate').recordings.map(r => r.name), [names[0]]);
    const payload = path.join(root, `viewer/data/${names[0]}.js`), before = fs.statSync(payload);
    fs.writeFileSync(payload, fs.readFileSync(payload, 'utf8').replace('"name":"A"', '"name":"Z"'));
    fs.utimesSync(payload, before.atime, before.mtime);
    run(names[0]);
    assert.notEqual(record(names[0]).sourceHash, changed.sourceHash);
    assert.equal(record(names[0]).players[0].name, 'Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
