import { describe, expect, it } from 'vitest'
import { gunzip } from './loader'

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('gunzip (trend packs behind hosts that may or may not set Content-Encoding)', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252])

  it('decompresses real gzip bytes', async () => {
    const out = await gunzip(toBuffer(await gzip(payload)))
    expect(Array.from(out)).toEqual(Array.from(payload))
  })

  it('passes through bytes the browser already decompressed', async () => {
    const out = await gunzip(toBuffer(payload))
    expect(Array.from(out)).toEqual(Array.from(payload))
  })

  it('handles empty and 1-byte bodies without throwing', async () => {
    expect((await gunzip(new ArrayBuffer(0))).length).toBe(0)
    expect((await gunzip(toBuffer(new Uint8Array([0x1f])))).length).toBe(1)
  })
})
