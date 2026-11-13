/** Bounded raw output of a session; keeps the newest `capacity` bytes (ADR 0003, snapshot fallback). */
export class OutputBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly capacity: number) {}

  append(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    // Copy: the PTY may reuse its buffer.
    const chunk =
      data.byteLength > this.capacity ? data.slice(data.byteLength - this.capacity) : data.slice();
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (this.size > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.size - this.capacity;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  contents(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}
