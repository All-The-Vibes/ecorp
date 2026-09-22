import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  getOfficeCharacterAsset, getOfficeCharacterFrame, OFFICE_CHARACTER_ASSETS,
  OFFICE_CHARACTER_SHEET, OFFICE_PIXEL_ASSET_ROOT,
} from './characterAssets.ts'

test('runtime character descriptors match the shipped manifest, PNG dimensions, and original file bytes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../public/assets/office/pixel-agents/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(OFFICE_CHARACTER_ASSETS.map(({ id }) => id), manifest.characters.map(({ id }) => id))
  assert.deepEqual(OFFICE_CHARACTER_SHEET, manifest.characterSheet)
  for (const asset of OFFICE_CHARACTER_ASSETS) {
    assert.match(asset.id, /^char_\d+$/)
    assert.equal(asset.src, `${OFFICE_PIXEL_ASSET_ROOT}/characters/${asset.id}.png`)
    const declared = manifest.characters.find(({ id }) => id === asset.id)
    for (const field of ['src', 'upstreamPath', 'gitBlobSha1', 'sha256', 'bytes']) assert.equal(asset[field], declared[field])
    const bytes = await readFile(new URL(`../../public${asset.src}`, import.meta.url))
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(bytes.readUInt32BE(16), 112)
    assert.equal(bytes.readUInt32BE(20), 96)
    assert.equal(bytes.length, asset.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), asset.gitBlobSha1)
  }
})

test('named characters and stable worker identities retain their appearance across reordered snapshots', () => {
  for (const asset of OFFICE_CHARACTER_ASSETS) assert.equal(getOfficeCharacterAsset(asset.id), asset)
  const identities = ['worker/alice', 'worker/bob', 'external/東京', '']
  const before = new Map(identities.map((id) => [id, getOfficeCharacterAsset(id)]))
  getOfficeCharacterAsset('a newly joined worker')
  for (const id of [...identities].reverse()) {
    assert.equal(getOfficeCharacterAsset(id), before.get(id))
    assert.ok(OFFICE_CHARACTER_ASSETS.includes(before.get(id)))
  }
})

test('numeric roster positions wrap without producing missing characters, and invalid numbers use the default', () => {
  assert.equal(getOfficeCharacterAsset(), OFFICE_CHARACTER_ASSETS[0])
  assert.equal(getOfficeCharacterAsset(6), OFFICE_CHARACTER_ASSETS[0])
  assert.equal(getOfficeCharacterAsset(-1), OFFICE_CHARACTER_ASSETS[5])
  assert.equal(getOfficeCharacterAsset(2.9), OFFICE_CHARACTER_ASSETS[2])
  assert.equal(getOfficeCharacterAsset(-1.9), OFFICE_CHARACTER_ASSETS[5])
  for (const invalid of [NaN, Infinity, -Infinity]) assert.equal(getOfficeCharacterAsset(invalid), OFFICE_CHARACTER_ASSETS[0])
})

test('walking uses the original three poses in a 0,1,2,1 cycle at the 150ms boundaries', () => {
  const times = [0, 149.999, 150, 299.999, 300, 449.999, 450, 599.999, 600]
  assert.deepEqual(times.map((time) => getOfficeCharacterFrame('walk', 'down', time).column), [0, 0, 1, 1, 2, 2, 1, 1, 0])
  assert.deepEqual([0, 150, 300, 450].map((time) => getOfficeCharacterFrame('walk', 'down', time).sx), [0, 16, 32, 16])
})

test('idle, typing, reading and facing use the actual source-sheet rows and columns', () => {
  assert.deepEqual(getOfficeCharacterFrame(), {
    sx: 16, sy: 0, sw: 16, sh: 32, column: 1, row: 0, animationFrame: 0, flipX: false,
  })
  assert.deepEqual([0, 299.999, 300, 600].map((time) => getOfficeCharacterFrame('type', 'down', time).column), [3, 3, 4, 3])
  assert.deepEqual([0, 300, 600].map((time) => getOfficeCharacterFrame('read', 'down', time).column), [5, 6, 5])
  for (const [direction, sy, flipX] of [['down', 0, false], ['up', 32, false], ['right', 64, false], ['left', 64, true]]) {
    const frame = getOfficeCharacterFrame('idle', direction, 10_000)
    assert.equal(frame.sy, sy)
    assert.equal(frame.flipX, flipX)
  }
})

test('invalid or negative animation time selects the first pose without invalid source coordinates', () => {
  for (const time of [-1, -100_000, NaN, Infinity, -Infinity]) {
    assert.deepEqual(getOfficeCharacterFrame('walk', 'left', time), getOfficeCharacterFrame('walk', 'left', 0))
  }
})

test('every animation and direction remains inside a real sheet after long-running animation', () => {
  for (const animation of ['idle', 'walk', 'type', 'read']) {
    for (const direction of ['down', 'up', 'left', 'right']) {
      for (const time of [0, 150, 300, 450, 600, 3_600_000, Number.MAX_SAFE_INTEGER]) {
        const frame = getOfficeCharacterFrame(animation, direction, time)
        assert.ok(Number.isInteger(frame.sx) && Number.isInteger(frame.sy))
        assert.ok(frame.sx >= 0 && frame.sx + frame.sw <= 112)
        assert.ok(frame.sy >= 0 && frame.sy + frame.sh <= 96)
        assert.equal(frame.sw, 16)
        assert.equal(frame.sh, 32)
      }
    }
  }
})
