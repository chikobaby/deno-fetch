import {Reader, ReadResult} from "deno";
import {BufReader} from "https://deno.land/x/io/bufio.ts";
import {TextProtoReader} from "https://deno.land/x/textproto/mod.ts";

export type HttpResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  body: Reader;
}

export async function readHttpResponse(
  r: Reader
): Promise<HttpResponse> {
  const reader = new BufReader(r);
  const tpReader = new TextProtoReader(reader);
  // read status line
  const [resLine, state] = await tpReader.readLine();
  const [m, _, status, statusText] = resLine.match(/^([^ ]+)? (\d{3}) (.+?)$/);
  // read header
  const [headers] = await tpReader.readMIMEHeader();
  // read body
  const resContentLength = headers.get("content-length");
  const contentLength = parseInt(resContentLength);
  let bodyReader: Reader;
  if (headers.get("transfer-encoding") !== "chunked") {
    bodyReader = new BodyReader(reader, contentLength);
  } else {
    bodyReader = new ChunkedBodyReader(reader);
  }
  return {
    status: parseInt(status),
    statusText,
    headers,
    body: bodyReader
  };
}

class BodyReader implements Reader {
  bodyLengthRemaining: number;

  constructor(private reader: Reader, private contentLength: number) {
    this.bodyLengthRemaining = contentLength;
  }

  async read(p: Uint8Array): Promise<ReadResult> {
    const {nread} = await this.reader.read(p);
    this.bodyLengthRemaining -= nread;
    return {nread, eof: this.bodyLengthRemaining === 0};
  }
}

class ChunkedBodyReader implements Reader {
  bufReader = new BufReader(this.reader);
  tpReader = new TextProtoReader(this.bufReader);

  constructor(private reader: Reader) {
  }

  chunks: Uint8Array[] = [];
  crlfBuf = new Uint8Array(2);
  finished: boolean = false;

  async read(p: Uint8Array): Promise<ReadResult> {
    const [line] = await this.tpReader.readLine();
    const len = parseInt(line, 16);
    if (len === 0) {
      this.finished = true;
    } else {
      const buf = new Uint8Array(len);
      await this.bufReader.readFull(buf);
      await this.bufReader.readFull(this.crlfBuf);
      this.chunks.push(buf);
    }
    const buf = this.chunks[0];
    if (buf) {
      if (p.byteOffset + buf.byteLength < p.byteLength) {
        p.set(buf, p.byteOffset);
        this.chunks.shift();
        return {nread: p.byteLength, eof: false};
      } else {
        p.set(buf.slice(buf.byteOffset, p.byteLength), p.byteOffset);
        this.chunks[0] = buf.slice(p.byteOffset, buf.byteLength);
        return {nread: p.byteLength, eof: false};
      }
    } else {
      return {nread: 0, eof: true};
    }
  }
}
