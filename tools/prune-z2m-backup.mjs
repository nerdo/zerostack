#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STOCK_ZSTACK_TCLK_LIMIT = 3;
const PRIORITY_CLUSTERS = new Set([0x0500, 0x0101]); // IAS Zone (1280), Door Lock (257)

/**
 * Normalize an IEEE 64-bit address to lowercase 16-char hex without `0x`.
 */
export function normalizeIeee(ieee) {
  if (typeof ieee !== 'string') return '';
  return ieee.trim().toLowerCase().replace(/^0x/, '').replace(/:/g, '');
}

/**
 * Normalize `nwk_address` for `open-coordinator-backup` v1:
 * `0x0000` (for non-coordinator devices) and `0xFFF8..0xFFFF` map to `null`;
 * valid unicast short addresses map to 4-char lowercase hex.
 */
export function normalizeNwkAddress(nwk) {
  if (nwk === null || nwk === undefined) return null;
  if (typeof nwk !== 'string') return nwk;
  const clean = nwk.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,4}$/.test(clean)) return nwk;
  const val = parseInt(clean, 16);
  if (val === 0x0000 || (val >= 0xfff8 && val <= 0xffff)) return null;
  return clean.padStart(4, '0');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check whether a backup device's `link_key.key` matches TI Z-Stack / zigbee-herdsman's
 * exact `TCLK_SEED` derivation:
 * `derived[j] = tclkSeed[(j + shift) % 16] ^ ieeeBytes[7 - (j % 8)]` for `shift in 0..15`.
 */
export function isSeedDerivedLinkKey(linkKeyHex, tclkSeedHex, ieeeHex) {
  if (typeof linkKeyHex !== 'string') return false;
  const keyBytes = hexToBytes(linkKeyHex);
  const seedBytes = hexToBytes(tclkSeedHex);
  const ieeeBytes = hexToBytes(normalizeIeee(ieeeHex));
  if (!keyBytes || !seedBytes || !ieeeBytes) return false;
  if (keyBytes.length !== 16 || seedBytes.length !== 16 || ieeeBytes.length !== 8) {
    return false;
  }

  const derived = new Uint8Array(16);
  for (let shift = 0; shift < 16; shift++) {
    for (let j = 0; j < 16; j++) {
      derived[j] = seedBytes[(j + shift) % 16] ^ ieeeBytes[7 - (j % 8)];
    }
    if (bytesEqual(keyBytes, derived)) return true;
  }

  return false;
}

function extractClusterIds(record) {
  const clusters = new Set();
  const endpoints = record.endpoints && typeof record.endpoints === 'object' ? record.endpoints : {};

  for (const epKey of Object.keys(endpoints)) {
    const ep = endpoints[epKey];
    if (!ep || typeof ep !== 'object') continue;
    for (const listKey of ['inClusterList', 'outClusterList', 'inputClusters', 'outputClusters']) {
      const arr = ep[listKey];
      if (!Array.isArray(arr)) continue;
      for (const cid of arr) {
        if (typeof cid === 'number') clusters.add(cid);
      }
    }
    if (ep.clusters && typeof ep.clusters === 'object') {
      if ('ssIasZone' in ep.clusters) clusters.add(0x0500);
      if ('closuresDoorLock' in ep.clusters) clusters.add(0x0101);
    }
  }
  return clusters;
}

/**
 * Parse Zigbee2MQTT `database.db` (JSON-lines) into active non-coordinator devices.
 */
export function parseDatabaseDb(dbContent) {
  const devices = new Map();
  for (const rawLine of dbContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'Coordinator') continue;
    const ieee = normalizeIeee(rec.ieeeAddr);
    if (!ieee) continue;
    const clusters = extractClusterIds(rec);
    const hasPriorityCluster = [...PRIORITY_CLUSTERS].some((cid) => clusters.has(cid));
    devices.set(ieee, {
      ieeeAddr: ieee,
      friendlyName: rec.friendlyName || rec.friendly_name || `0x${ieee}`,
      modelId: rec.modelId || rec.modelID || 'unknown',
      type: rec.type || 'unknown',
      hasPriorityCluster,
      clusters: [...clusters],
    });
  }
  return devices;
}

/**
 * Check for signs that Zigbee2MQTT is currently running in `dataDir`.
 */
export function checkZ2mRunningSignals(dataDir, nowMs = Date.now()) {
  const warnings = [];
  for (const name of ['z2m.pid', 'zigbee2mqtt.pid', 'database.db.lock', 'coordinator_backup.json.lock']) {
    if (fs.existsSync(path.join(dataDir, name))) {
      warnings.push(`Found active lock/pid file: ${name}`);
    }
  }
  const logDir = path.join(dataDir, 'log');
  if (fs.existsSync(logDir) && fs.statSync(logDir).isDirectory()) {
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const logFile = path.join(logDir, entry.name, 'log.log');
      if (fs.existsSync(logFile)) {
        const ageMs = nowMs - fs.statSync(logFile).mtimeMs;
        if (ageMs >= 0 && ageMs < 10_000) {
          warnings.push(`Recent log activity (${Math.round(ageMs / 1000)}s ago): ${logFile}`);
        }
      }
    }
  }
  return warnings;
}

/**
 * Prune orphaned devices and optionally fit explicit link keys to Stock TI Z-Stack's 3-slot limit.
 */
export function pruneZ2mBackup(dataDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const fitStockZstack = Boolean(options.fitStockZstack);
  const force = Boolean(options.force);
  const nowMs = options.nowMs ?? Date.now();

  const dbPath = path.join(dataDir, 'database.db');
  const backupPath = path.join(dataDir, 'coordinator_backup.json');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Missing database.db in ${dataDir}`);
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Missing coordinator_backup.json in ${dataDir}`);
  }

  const runningSignals = checkZ2mRunningSignals(dataDir, nowMs);
  if (runningSignals.length > 0 && !dryRun && !force) {
    throw new Error(
      `Refusing to modify coordinator_backup.json while Zigbee2MQTT appears active (${runningSignals.join('; ')}). Stop Zigbee2MQTT first or pass --force.`
    );
  }

  const activeDb = parseDatabaseDb(fs.readFileSync(dbPath, 'utf8'));
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const tclkSeed = backup?.stack_specific?.zstack?.tclk_seed ?? '';
  const origDevices = Array.isArray(backup.devices) ? backup.devices : [];

  const keptDevices = [];
  const orphanedDevices = [];
  let normalizedNwkCount = 0;

  for (const dev of origDevices) {
    const ieee = normalizeIeee(dev?.ieee_address);
    if (!ieee || !activeDb.has(ieee)) {
      orphanedDevices.push(ieee || 'unknown');
      continue;
    }
    const copy = structuredClone(dev);
    if (
      Object.prototype.hasOwnProperty.call(copy, 'network_address') &&
      !Object.prototype.hasOwnProperty.call(copy, 'nwk_address')
    ) {
      copy.nwk_address = copy.network_address;
      delete copy.network_address;
    }
    const normNwk = normalizeNwkAddress(copy.nwk_address);
    if (normNwk !== copy.nwk_address) {
      copy.nwk_address = normNwk;
      normalizedNwkCount += 1;
    }
    keptDevices.push(copy);
  }

  const seedDerivedDevices = [];
  const explicitKeyDevices = [];

  for (const dev of keptDevices) {
    const ieee = normalizeIeee(dev.ieee_address);
    const linkKeyHex = dev?.link_key?.key;
    if (!linkKeyHex || isSeedDerivedLinkKey(linkKeyHex, tclkSeed, ieee)) {
      seedDerivedDevices.push(dev);
    } else {
      explicitKeyDevices.push(dev);
    }
  }

  const strippedDevices = [];
  if (fitStockZstack && explicitKeyDevices.length > STOCK_ZSTACK_TCLK_LIMIT) {
    const prioritized = [...explicitKeyDevices].sort((a, b) => {
      const aInfo = activeDb.get(normalizeIeee(a.ieee_address));
      const bInfo = activeDb.get(normalizeIeee(b.ieee_address));
      const aPri = aInfo?.hasPriorityCluster ? 1 : 0;
      const bPri = bInfo?.hasPriorityCluster ? 1 : 0;
      return bPri - aPri;
    });
    const toStrip = prioritized.slice(STOCK_ZSTACK_TCLK_LIMIT);
    for (const dev of toStrip) {
      const ieee = normalizeIeee(dev.ieee_address);
      const info = activeDb.get(ieee);
      delete dev.link_key;
      strippedDevices.push({
        ieeeAddr: `0x${ieee}`,
        friendlyName: info?.friendlyName ?? `0x${ieee}`,
        modelId: info?.modelId ?? 'unknown',
      });
    }
  }

  backup.devices = keptDevices;

  let bakPath = null;
  if (!dryRun) {
    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
    bakPath = path.join(dataDir, `coordinator_backup.json.bak.${stamp}`);
    fs.copyFileSync(backupPath, bakPath);
    const tmpPath = path.join(dataDir, `.coordinator_backup.json.tmp.${process.pid}`);
    fs.writeFileSync(tmpPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, backupPath);
  }

  return {
    dryRun,
    fitStockZstack,
    runningSignals,
    totalOriginal: origDevices.length,
    totalRemaining: keptDevices.length,
    orphanedRemoved: orphanedDevices.length,
    normalizedNwkCount,
    seedDerivedCount: seedDerivedDevices.length,
    explicitKeyCount: explicitKeyDevices.length,
    strippedDevices,
    bakPath,
  };
}

function main(argv) {
  let dataDir = null;
  let dryRun = false;
  let fitStockZstack = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--fit-stock-zstack') fitStockZstack = true;
    else if (arg === '--force') force = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node tools/prune-z2m-backup.mjs <z2m-data-dir> [--dry-run] [--fit-stock-zstack] [--force]');
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      return 1;
    } else if (!dataDir) {
      dataDir = path.resolve(arg);
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      return 1;
    }
  }

  if (!dataDir) {
    console.error('Usage: node tools/prune-z2m-backup.mjs <z2m-data-dir> [--dry-run] [--fit-stock-zstack] [--force]');
    return 1;
  }

  console.log('⚠️  IMPORTANT: Zigbee2MQTT MUST be stopped before modifying coordinator_backup.json.');
  const res = pruneZ2mBackup(dataDir, { dryRun, fitStockZstack, force });
  if (res.runningSignals.length > 0) {
    console.warn(`⚠️  Active Zigbee2MQTT signal(s): ${res.runningSignals.join('; ')}`);
  }
  console.log(`Mode: ${res.dryRun ? 'DRY RUN (no files modified)' : 'WRITE'}`);
  if (res.bakPath) console.log(`Backup written: ${res.bakPath}`);
  console.log(`Orphaned devices removed: ${res.orphanedRemoved} (${res.totalOriginal} -> ${res.totalRemaining} active)`);
  if (res.normalizedNwkCount > 0) {
    console.log(`Reserved/zero nwk_address normalized to null: ${res.normalizedNwkCount}`);
  }
  console.log(`Active devices with seed-derived / no explicit link keys (0 Stock slots): ${res.seedDerivedCount}`);
  console.log(`Active devices with explicit non-seed link keys: ${res.explicitKeyCount} (Stock TI Z-Stack limit: ${STOCK_ZSTACK_TCLK_LIMIT})`);

  if (res.explicitKeyCount > STOCK_ZSTACK_TCLK_LIMIT && !res.fitStockZstack) {
    console.log(
      `INFO: ZeroStack supports all ${res.explicitKeyCount} explicit link keys natively. Pass --fit-stock-zstack only if downgrading to Stock TI Z-Stack 20240716+.`
    );
  }
  if (res.strippedDevices.length > 0) {
    console.log(
      `Stripped explicit link_key from ${res.strippedDevices.length} excess device(s) (normal ZCL traffic continues working; APS-encrypted TC rejoin/key-rotation requires re-pairing on Stock Z-Stack):`
    );
    for (const d of res.strippedDevices) {
      console.log(`  - ${d.friendlyName} (${d.ieeeAddr}, model=${d.modelId})`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
