import { Closer, Reader, ReadResult, Writer } from "deno";
import { BufState, BufWriter } from "https://deno.land/x/io@v0.2.6/bufio.ts";

const encoder = new TextEncoder();

function randomBoundary() {
  let boundary = "--------------------------";
  for (let i = 0; i < 24; i++) {
    boundary += Math.floor(Math.random() * 10).toString(16);
  }
  return boundary;
}

class PartReader implements Reader {
  constructor(private part: Part) {}

  read(p: Uint8Array): Promise<ReadResult> {
    return undefined;
  }
}

class Part implements Writer {
  closed = false;

  constructor(readonly multipartWriter: Writer) {}

  close(): void {
    this.closed = true;
  }

  async write(p: Uint8Array): Promise<number> {
    if (this.closed) {
      throw new Error("part is closed");
    }
    return this.multipartWriter.write(p);
  }
}

export class Multipart implements Writer, Closer {
  private _boundary: string;

  setBoundary(b: string) {
    if (this.lastPart) {
      throw new Error("setBoundary called after write");
    }
    if (b.length < 1 || b.length > 70) {
      throw new TypeError("invalid boundary length: " + b.length);
    }
    const end = b.length - 1;
    for (let i = 0; i < end; i++) {
      if (
        !b.charAt(i).match(/[a-zA-Z0-9'()+_,\-./:=?]/) ||
        (b.charAt(i) === " " && i != end)
      ) {
        throw new Error("invalid boundary character: " + b.charAt(i));
      }
    }
    this._boundary = b;
  }

  get boundary() {
    return this._boundary;
  }

  private lastPart: Part;
  bufWriter: BufWriter;

  constructor(readonly writer: Writer) {
    this._boundary = randomBoundary();
    this.bufWriter = new BufWriter(writer);
  }

  queuedChunks: string[] = [];

  async write(p: Uint8Array): Promise<number> {
    let chunk: string;
    while ((chunk = this.queuedChunks.shift())) {
      await this.bufWriter.write(encoder.encode(chunk));
    }
    return this.bufWriter.write(p);
  }

  flush(): Promise<BufState> {
    return this.bufWriter.flush();
  }

  formDataContentType(): string {
    if (this.boundary.match(/[()<>@,;:"/\[\]?= ]/)) {
      this._boundary = `"${this.boundary}"`;
    }
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  createPart(headers: Headers): Writer {
    if (this.lastPart) {
      this.lastPart.close();
    }
    let buf = "";
    if (this.lastPart) {
      buf += `\r\n--${this.boundary}\r\n`;
    } else {
      buf += `--${this.boundary}`;
    }
    for (const [key, value] of headers.entries()) {
      buf += `${key}: ${value}\r\n`;
    }
    buf += `\r\n`;
    this.queuedChunks.push(buf);
    const part = new Part(this);
    this.lastPart = part;
    return part;
  }

  createFormFile(field: string, filename: string): Writer {
    const h = new Headers();
    h.set(
      "Content-Disposition",
      `form-data; name="${field}"; filename="${filename}"`
    );
    h.set("Content-Type", "application/octet-stream");
    return this.createPart(h);
  }

  createFormField(field: string): Writer {
    const h = new Headers();
    h.set("Content-Disposition", `form-data; name="${field}"`);
    h.set("Content-Type", "application/octet-stream");
    return this.createPart(h);
  }

  async writeField(field: string, value: string) {
    const f = await this.createFormField(field);
    await f.write(encoder.encode(value));
  }

  async close() {
    if (this.lastPart) {
      this.lastPart.close();
      this.lastPart = void 0;
    }
    await this.write(encoder.encode(`\r\n--${this.boundary}--\r\n`));
    await this.flush();
  }
}