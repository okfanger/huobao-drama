// Run with: npx tsx --test tests/ffmpeg-merge.test.ts
// For Docker, mount this directory at /app/backend/tests and use the image's tsx.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { FfprobeData } from 'fluent-ffmpeg'

test('real merge API encodes clips, probes duration and extracts a poster', { timeout: 60_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-ffmpeg-test-'))
  process.env.HUOBAO_DATA_DIR = dataRoot
  process.env.SQLITE_PATH = path.join(dataRoot, 'test.sqlite3')
  process.env.STORAGE_PATH = path.join(dataRoot, 'static')

  const { db, schema, getInsertId } = await import('../src/db/index.js')
  try {
    const { ffmpeg, checkFfmpegSuite } = await import('../src/utils/ffmpeg.js')
    const { default: mergeRoute } = await import('../src/routes/merge.js')
    assert.deepEqual(await checkFfmpegSuite(), { ffmpeg: true, ffprobe: true })

    const clipDir = path.join(dataRoot, 'static', 'videos')
    fs.mkdirSync(clipDir, { recursive: true })
    const ffmpegBin = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static')
    for (const color of ['red', 'blue']) {
      // FFmpeg 9 adds device flags to -formats that fluent-ffmpeg cannot parse.
      // Create fixtures with the binary directly; the API still exercises fluent-ffmpeg.
      await promisify(execFile)(ffmpegBin, [
        '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=24:d=1`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        path.join(clipDir, `${color}.mp4`),
      ])
    }

    const ts = new Date().toISOString()
    const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: 'FFmpeg test', createdAt: ts, updatedAt: ts }))
    const episodeId = getInsertId(await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Test episode', createdAt: ts, updatedAt: ts }))
    const storyboardIds: number[] = []
    for (const [index, color] of ['red', 'blue'].entries()) {
      storyboardIds.push(getInsertId(await db.insert(schema.storyboards).values({
        episodeId, storyboardNumber: index + 1, videoUrl: `static/videos/${color}.mp4`, createdAt: ts, updatedAt: ts,
      })))
    }

    const response = await mergeRoute.request(`/episodes/${episodeId}/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard_ids: storyboardIds }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.data.status, 'processing')

    let merged
    const deadline = Date.now() + 30_000
    do {
      const status = await mergeRoute.request(`/episodes/${episodeId}/merge`)
      merged = (await status.json()).data
      if (merged?.status === 'completed' || merged?.status === 'failed') break
      await delay(100)
    } while (Date.now() < deadline)

    assert.equal(merged?.status, 'completed', JSON.stringify(merged))
    assert.equal(merged.id, body.data.merge_id)
    assert.equal(merged.duration, 2)
    const output = path.join(dataRoot, merged.merged_url)
    assert.ok(fs.statSync(output).size > 0)
    assert.ok(fs.statSync(output.replace(/\.mp4$/, '_poster.jpg')).size > 0)
    const episode = await db.select().from(schema.episodes)
    assert.equal(episode[0].videoUrl, merged.merged_url)
    const tempDir = path.join(dataRoot, 'static', 'temp')
    assert.deepEqual(fs.readdirSync(tempDir), [])

    const metadata = await new Promise<FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(output, (err, result) => err ? reject(err) : resolve(result))
    })
    assert.ok(metadata.streams.some(stream => stream.codec_name === 'h264'))
    assert.ok(metadata.streams.some(stream => stream.codec_name === 'aac'))
    assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.2)
  } finally {
    db.$client.close()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
