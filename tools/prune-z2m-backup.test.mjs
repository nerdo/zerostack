import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isSeedDerivedLinkKey,
  normalizeNwkAddress,
  pruneZ2mBackup,
} from './prune-z2m-backup.mjs';

const SEED_HEX = '00112233445566778899aabbccddeeff';
const ALLIANCE_HEX = '5a6967426565416c6c69616e63653039';
const GOLDEN_SHIFT7_KEY = '718899aabb41c8eef900112233c94066';

function deriveTclkHex(seedHex, ieeeHex, shift) {
  const seed = Buffer.from(seedHex, 'hex');
  const ieee = Buffer.from(ieeeHex, 'hex');
  const out = Buffer.alloc(16);
  for (let j = 0; j < 16; j++) {
    out[j] = seed[(j + shift) % 16] ^ ieee[7 - (j % 8)];
  }
  return out.toString('hex');
}

function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-z2m-test-'));
  const dbLines = [
    JSON.stringify({ id: 1, type: 'Coordinator', ieeeAddr: '0x00124b0000000001' }),
    JSON.stringify({
      id: 2,
      type: 'EndDevice',
      ieeeAddr: '0x00158d0000000002',
      friendlyName: 'front_door_lock',
      modelId: 'LOCK-1',
      endpoints: { '1': { inClusterList: [0, 0x0101] } },
    }),
    JSON.stringify({
      id: 3,
      type: 'EndDevice',
      ieeeAddr: '0x00158d0000000003',
      friendlyName: 'hall_motion_ias',
      modelId: 'IAS-1',
      endpoints: { '1': { inClusterList: [0], clusters: { ssIasZone: { attributes: {} } } } },
    }),
    JSON.stringify({
      id: 4,
      type: 'Router',
      ieeeAddr: '0x00158d0000000004',
      friendlyName: 'kitchen_plug',
      modelId: 'PLUG-1',
      endpoints: { '1': { inClusterList: [0, 6] } },
    }),
    JSON.stringify({
      id: 5,
      type: 'Router',
      ieeeAddr: '0x00158d0000000005',
      friendlyName: 'office_plug',
      modelId: 'PLUG-2',
      endpoints: { '1': { inClusterList: [0, 6] } },
    }),
    JSON.stringify({
      id: 6,
      type: 'Router',
      ieeeAddr: '0x00158d0000000006',
      friendlyName: 'seed_bulb',
      modelId: 'BULB-1',
      endpoints: { '1': { inClusterList: [0, 8] } },
    }),
  ];
  fs.writeFileSync(path.join(dir, 'database.db'), `${dbLines.join('\n')}\n`, 'utf8');

  const backup = {
    coordinator_ieee: '00124b0000000001',
    stack_specific: { zstack: { tclk_seed: SEED_HEX } },
    devices: [
      {
        nwk_address: 'ffff',
        ieee_address: '00158d0000000002',
        link_key: { key: '11111111111111111111111111111111', rx_counter: 0, tx_counter: 1 },
      },
      {
        nwk_address: '0000',
        ieee_address: '00158d0000000003',
        link_key: { key: '22222222222222222222222222222222', rx_counter: 0, tx_counter: 1 },
      },
      {
        nwk_address: '3333',
        ieee_address: '00158d0000000004',
        link_key: { key: '33333333333333333333333333333333', rx_counter: 0, tx_counter: 1 },
      },
      {
        nwk_address: 'fffe',
        ieee_address: '00158d0000000005',
        link_key: { key: ALLIANCE_HEX, rx_counter: 0, tx_counter: 1 },
      },
      {
        nwk_address: '5555',
        ieee_address: '00158d0000000006',
        link_key: { key: GOLDEN_SHIFT7_KEY, rx_counter: 0, tx_counter: 1 },
      },
      {
        nwk_address: '9999',
        ieee_address: '00158d0000dead99', // orphaned
        link_key: { key: '99999999999999999999999999999999', rx_counter: 0, tx_counter: 1 },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'coordinator_backup.json'), JSON.stringify(backup, null, 2), 'utf8');
  return dir;
}

test('exact TI Z-Stack TCLK_SEED derivation (shift 0..15) and negative controls', () => {
  const ieeeHex = '00158d0000000006';
  assert.equal(deriveTclkHex(SEED_HEX, ieeeHex, 7), GOLDEN_SHIFT7_KEY);
  assert.equal(isSeedDerivedLinkKey(GOLDEN_SHIFT7_KEY, SEED_HEX, ieeeHex), true);

  for (let shift = 0; shift < 16; shift++) {
    assert.equal(isSeedDerivedLinkKey(deriveTclkHex(SEED_HEX, ieeeHex, shift), SEED_HEX, ieeeHex), true);
  }

  // Negative 1: Raw rotated seed without IEEE XOR is explicit non-seed
  assert.equal(isSeedDerivedLinkKey('778899aabbccddeeff00112233445566', SEED_HEX, ieeeHex), false);

  // Negative 2: Big-endian XORed seed is explicit non-seed
  const seed = Buffer.from(SEED_HEX, 'hex');
  const ieee = Buffer.from(ieeeHex, 'hex');
  const beXored = Buffer.alloc(16);
  for (let j = 0; j < 16; j++) beXored[j] = seed[(j + 7) % 16] ^ ieee[j % 8];
  assert.equal(isSeedDerivedLinkKey(beXored.toString('hex'), SEED_HEX, ieeeHex), false);

  // Negative 3: ZigBeeAlliance09 consumes an explicit Stock Z-Stack slot (false)
  assert.equal(isSeedDerivedLinkKey(ALLIANCE_HEX, SEED_HEX, ieeeHex), false);

  // nwk_address sentinel normalization
  assert.equal(normalizeNwkAddress('ffff'), null);
  assert.equal(normalizeNwkAddress('fffe'), null);
  assert.equal(normalizeNwkAddress('0000'), null);
  assert.equal(normalizeNwkAddress('0x1234'), '1234');
});

test('--dry-run does not mutate files', () => {
  const dir = makeFixtureDir();
  try {
    const before = fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8');
    const res = pruneZ2mBackup(dir, { dryRun: true, fitStockZstack: true });
    assert.equal(res.orphanedRemoved, 1);
    assert.equal(res.seedDerivedCount, 1);
    assert.equal(res.explicitKeyCount, 4);
    assert.equal(res.strippedDevices.length, 1);
    assert.equal(res.bakPath, null);
    assert.equal(fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orphan pruning, nwk_address null sentinel, .bak creation, and ssIasZone/Lock priority under --fit-stock-zstack', () => {
  const dir = makeFixtureDir();
  try {
    // Without --fit-stock-zstack: prunes orphan, normalizes reserved/zero nwk_address to null, keeps all 4 explicit keys
    const pass1 = pruneZ2mBackup(dir, { dryRun: false, fitStockZstack: false, nowMs: 1700000000000 });
    assert.equal(pass1.orphanedRemoved, 1);
    assert.equal(pass1.normalizedNwkCount, 3);
    assert.equal(pass1.explicitKeyCount, 4);
    assert.equal(pass1.strippedDevices.length, 0);
    assert.ok(pass1.bakPath && fs.existsSync(pass1.bakPath));

    const afterPass1 = JSON.parse(fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8'));
    assert.equal(afterPass1.devices.length, 5);
    assert.equal(afterPass1.devices[0].nwk_address, null);
    assert.equal(afterPass1.devices[1].nwk_address, null);
    assert.equal(afterPass1.devices[3].nwk_address, null);

    // With --fit-stock-zstack: keeps Door Lock (0x0101), IAS Zone (ep.clusters.ssIasZone), and 1 plug; strips ZigBeeAlliance09 excess plug
    const pass2 = pruneZ2mBackup(dir, { dryRun: false, fitStockZstack: true, nowMs: 1700000001000 });
    assert.equal(pass2.strippedDevices.length, 1);
    assert.equal(pass2.strippedDevices[0].friendlyName, 'office_plug');

    const afterPass2 = JSON.parse(fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8'));
    const lockDev = afterPass2.devices.find((d) => d.ieee_address === '00158d0000000002');
    const iasDev = afterPass2.devices.find((d) => d.ieee_address === '00158d0000000003');
    const officeDev = afterPass2.devices.find((d) => d.ieee_address === '00158d0000000005');
    assert.ok(lockDev.link_key);
    assert.ok(iasDev.link_key);
    assert.equal(officeDev.link_key, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to write when active z2m.pid exists unless --force', () => {
  const dir = makeFixtureDir();
  try {
    fs.writeFileSync(path.join(dir, 'z2m.pid'), '12345\n', 'utf8');
    assert.throws(() => pruneZ2mBackup(dir, { dryRun: false }), /Zigbee2MQTT appears active/);
    const forced = pruneZ2mBackup(dir, { dryRun: false, force: true });
    assert.equal(forced.orphanedRemoved, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone ZHA backup .json file skips database.db pruning and runs --fit-stock-zstack', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-zha-test-'));
  try {
    const zhaPath = path.join(dir, 'zha_backup.json');
    const zhaBackup = {
      coordinator_ieee: '00124b0000000001',
      stack_specific: { zstack: { tclk_seed: SEED_HEX } },
      devices: [
        { nwk_address: 'ffff', ieee_address: '00158d0000000002', link_key: { key: '11111111111111111111111111111111', rx_counter: 0, tx_counter: 1 } },
        { nwk_address: '0000', ieee_address: '00158d0000000003', link_key: { key: '22222222222222222222222222222222', rx_counter: 0, tx_counter: 1 } },
        { nwk_address: '3333', ieee_address: '00158d0000000004', link_key: { key: '33333333333333333333333333333333', rx_counter: 0, tx_counter: 1 } },
        { nwk_address: '4444', ieee_address: '00158d0000000005', link_key: { key: ALLIANCE_HEX, rx_counter: 0, tx_counter: 1 } },
        { nwk_address: '5555', ieee_address: '00158d0000000006', link_key: { key: GOLDEN_SHIFT7_KEY, rx_counter: 0, tx_counter: 1 } },
      ],
    };
    fs.writeFileSync(zhaPath, JSON.stringify(zhaBackup, null, 2), 'utf8');

    const res = pruneZ2mBackup(zhaPath, { dryRun: false, fitStockZstack: true, nowMs: 1700000002000 });
    assert.equal(res.isFileMode, true);
    assert.equal(res.orphanPruningEnabled, false);
    assert.equal(res.orphanedRemoved, 0);
    assert.equal(res.totalRemaining, 5);
    assert.equal(res.normalizedNwkCount, 2);
    assert.equal(res.seedDerivedCount, 1);
    assert.equal(res.explicitKeyCount, 4);
    assert.equal(res.strippedDevices.length, 1);
    assert.ok(res.bakPath && res.bakPath.startsWith(`${zhaPath}.bak.`) && fs.existsSync(res.bakPath));

    const updated = JSON.parse(fs.readFileSync(zhaPath, 'utf8'));
    assert.equal(updated.devices[0].nwk_address, null);
    assert.equal(updated.devices[1].nwk_address, null);
    assert.equal(updated.devices[3].link_key, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI safety rails: lock/log refusal, --dry-run mtime invariance, corrupt JSON & ZHA filename with spaces', () => {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'prune-z2m-backup.mjs');

  // 1. Active *.lock and recent log.txt refusal via CLI, allowed under --dry-run and --force
  for (const markerFile of ['custom.lock', 'log.txt']) {
    const dir = makeFixtureDir();
    try {
      const backupFile = path.join(dir, 'coordinator_backup.json');
      const beforeBytes = fs.readFileSync(backupFile, 'utf8');
      fs.writeFileSync(path.join(dir, markerFile), 'active\n', 'utf8');

      const blocked = spawnSync(process.execPath, [cliPath, dir], { encoding: 'utf8' });
      assert.notEqual(blocked.status, 0);
      assert.equal(fs.readFileSync(backupFile, 'utf8'), beforeBytes);

      const dry = spawnSync(process.execPath, [cliPath, dir, '--dry-run'], { encoding: 'utf8' });
      assert.equal(dry.status, 0);
      assert.equal(fs.readFileSync(backupFile, 'utf8'), beforeBytes);
      assert.equal(fs.readdirSync(dir).some((f) => f.includes('.bak.') || f.includes('.tmp.')), false);

      const forced = spawnSync(process.execPath, [cliPath, dir, '--force'], { encoding: 'utf8' });
      assert.equal(forced.status, 0);
      assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('coordinator_backup.json.bak.')), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 2. --dry-run invariance (mtimeMs & zero .bak/.tmp)
  {
    const dir = makeFixtureDir();
    try {
      const backupFile = path.join(dir, 'coordinator_backup.json');
      const beforeStat = fs.statSync(backupFile);
      const dry = spawnSync(process.execPath, [cliPath, dir, '--dry-run', '--fit-stock-zstack'], { encoding: 'utf8' });
      assert.equal(dry.status, 0);
      assert.equal(fs.statSync(backupFile).mtimeMs, beforeStat.mtimeMs);
      assert.equal(fs.readdirSync(dir).some((f) => f.includes('.bak.') || f.includes('.tmp.')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 3. Corrupt JSON input: non-zero exit & zero .bak/.tmp leftovers
  {
    const dir = makeFixtureDir();
    try {
      fs.writeFileSync(path.join(dir, 'coordinator_backup.json'), '{corrupt json', 'utf8');
      const bad = spawnSync(process.execPath, [cliPath, dir], { encoding: 'utf8' });
      assert.notEqual(bad.status, 0);
      assert.equal(fs.readdirSync(dir).some((f) => f.includes('.bak.') || f.includes('.tmp.')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 4. Filename with spaces in standalone ZHA mode + log.txt in parent dir does not block
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-zha-spaces-'));
    try {
      const zhaPath = path.join(dir, 'ZHA backup 2026-11-19.json');
      fs.writeFileSync(path.join(dir, 'log.txt'), 'recent\n', 'utf8');
      fs.writeFileSync(
        zhaPath,
        JSON.stringify({
          coordinator_ieee: '00124b0000000001',
          stack_specific: { zstack: { tclk_seed: SEED_HEX } },
          devices: [
            { nwk_address: 'ffff', ieee_address: '00158d0000000002', link_key: { key: '11'.repeat(16), rx_counter: 0, tx_counter: 1 } },
          ],
        }),
        'utf8'
      );
      const res = spawnSync(process.execPath, [cliPath, zhaPath], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('ZHA backup 2026-11-19.json.bak.')), true);
      const updated = JSON.parse(fs.readFileSync(zhaPath, 'utf8'));
      assert.equal(updated.devices[0].nwk_address, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('250-device scale (all 16 shifts), idempotency, K=0/3/4/5 boundaries, colon IEEE & duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-scale-test-'));
  try {
    const dbLines = [
      JSON.stringify({ id: 1, type: 'Coordinator', ieeeAddr: '0x00124b0000000001' }),
      JSON.stringify({ id: 2, type: 'Group', groupID: 1, friendlyName: 'all_lights' }),
    ];
    const devices = [];
    for (let i = 0; i < 200; i++) {
      const ieee = `00158d000000${(10 + i).toString(16).padStart(4, '0')}`;
      dbLines.push(
        JSON.stringify({
          id: 10 + i,
          type: 'Router',
          ieeeAddr: `0x${ieee}`,
          friendlyName: `seed_${i}`,
          endpoints: { '1': { inClusterList: [0, 6] } },
        })
      );
      devices.push({
        nwk_address: (0x1000 + 10 + i).toString(16).padStart(4, '0'),
        ieee_address: ieee,
        is_child: false,
        link_key: { key: deriveTclkHex(SEED_HEX, ieee, i % 16), rx_counter: 42 + i, tx_counter: 100 + i },
      });
    }
    for (let i = 0; i < 30; i++) {
      devices.push({
        nwk_address: (0x2000 + i).toString(16).padStart(4, '0'),
        ieee_address: `00158d00dead${i.toString(16).padStart(4, '0')}`,
        is_child: true,
        link_key: { key: `aa${i.toString(16).padStart(2, '0')}`.repeat(8), rx_counter: 1, tx_counter: 2 },
      });
    }
    for (let i = 0; i < 12; i++) {
      const ieee = `00158d000000${(400 + i).toString(16).padStart(4, '0')}`;
      const isPri = i < 4;
      dbLines.push(
        JSON.stringify({
          id: 400 + i,
          type: 'EndDevice',
          ieeeAddr: `0x${ieee}`,
          friendlyName: `exp_${i}`,
          endpoints: isPri ? { '1': { inClusterList: [0], clusters: { ssIasZone: {} } } } : { '1': { inClusterList: [0, 6] } },
        })
      );
      devices.push({
        nwk_address: (0x3000 + i).toString(16).padStart(4, '0'),
        ieee_address: ieee,
        is_child: true,
        link_key: { key: i < 8 ? ALLIANCE_HEX : `${10 + i}`.repeat(16), rx_counter: 5, tx_counter: 9 },
      });
    }
    for (let i = 0; i < 8; i++) {
      const ieee = `00158d000000${(500 + i).toString(16).padStart(4, '0')}`;
      dbLines.push(JSON.stringify({ id: 500 + i, type: 'Router', ieeeAddr: `0x${ieee}`, friendlyName: `keyless_${i}` }));
      devices.push({ nwk_address: (0x4000 + i).toString(16).padStart(4, '0'), ieee_address: ieee, is_child: false });
    }

    fs.writeFileSync(path.join(dir, 'database.db'), `${dbLines.join('\n')}\n`, 'utf8');
    fs.writeFileSync(
      path.join(dir, 'coordinator_backup.json'),
      JSON.stringify({ coordinator_ieee: '00124b0000000001', stack_specific: { zstack: { tclk_seed: SEED_HEX } }, devices }),
      'utf8'
    );

    const pass1 = pruneZ2mBackup(dir, { dryRun: false, fitStockZstack: true, nowMs: 1700000005000 });
    assert.equal(pass1.orphanedRemoved, 30);
    assert.equal(pass1.totalRemaining, 220);
    assert.equal(pass1.seedDerivedCount, 208);
    assert.equal(pass1.explicitKeyCount, 12);
    assert.equal(pass1.strippedDevices.length, 9);

    const onceBytes = fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8');
    const pass2 = pruneZ2mBackup(dir, { dryRun: false, fitStockZstack: true, nowMs: 1700000006000 });
    assert.equal(pass2.orphanedRemoved, 0);
    assert.equal(pass2.strippedDevices.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'coordinator_backup.json'), 'utf8'), onceBytes);

    // Boundary K=3 (0 stripped) and colon/coord/duplicate deduplication
    const wildPath = path.join(dir, 'wild.json');
    fs.writeFileSync(
      wildPath,
      JSON.stringify({
        coordinator_ieee: '00124b0000000001',
        stack_specific: { zstack: { tclk_seed: SEED_HEX } },
        devices: [
          { nwk_address: '0000', ieee_address: '00:12:4b:00:00:00:00:01', link_key: { key: 'aa'.repeat(16), rx_counter: 0, tx_counter: 1 } },
          { nwk_address: '2222', ieee_address: '00:15:8d:00:01:23:45:67', link_key: { key: 'bb'.repeat(16), rx_counter: 0, tx_counter: 1 } },
          { nwk_address: '2222', ieee_address: '00158d0001234567', link_key: { key: 'bb'.repeat(16), rx_counter: 0, tx_counter: 1 } },
          { nwk_address: '3333', ieee_address: '00158d0001234568', link_key: { key: 'cc'.repeat(16), rx_counter: 0, tx_counter: 1 } },
          { nwk_address: '4444', ieee_address: '00158d0001234569', link_key: { key: 'dd'.repeat(16), rx_counter: 0, tx_counter: 1 } },
        ],
      }),
      'utf8'
    );
    const wildRes = pruneZ2mBackup(wildPath, { dryRun: false, fitStockZstack: true, nowMs: 1700000007000 });
    assert.equal(wildRes.totalRemaining, 3);
    assert.equal(wildRes.explicitKeyCount, 3);
    assert.equal(wildRes.strippedDevices.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
