type ScriptClass = "Script" | "LocalScript" | "ModuleScript";

export type PlaceScript = {
  className: ScriptClass;
  name: string;
  path: string;
  source: string;
};

type InstanceRecord = {
  className: string;
  name?: string;
  parent?: number;
  source?: string;
};

class Reader {
  offset = 0;
  constructor(readonly body: Buffer) {}

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.body.length) {
      throw new Error("Invalid or truncated Roblox place data");
    }
    const value = this.body.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u32(): number {
    const value = this.body.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    const value = this.body.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  string(maxBytes = 2_000_000): string {
    const length = this.u32();
    if (length > maxBytes) throw new Error("Roblox place string exceeds safety limit");
    return this.bytes(length).toString("utf8");
  }
}

function lz4Block(input: Buffer, expectedLength: number): Buffer {
  if (expectedLength > 128 * 1_024 * 1_024) {
    throw new Error("Roblox place chunk exceeds safety limit");
  }
  const output = Buffer.allocUnsafe(expectedLength);
  let source = 0;
  let target = 0;
  const length = (base: number): number => {
    let value = base;
    if (base !== 15) return value;
    while (source < input.length) {
      const next = input[source++]!;
      value += next;
      if (next !== 255) return value;
    }
    throw new Error("Invalid LZ4 length");
  };

  while (source < input.length) {
    const token = input[source++]!;
    const literalLength = length(token >>> 4);
    if (
      source + literalLength > input.length ||
      target + literalLength > output.length
    ) {
      throw new Error("Invalid LZ4 literal");
    }
    input.copy(output, target, source, source + literalLength);
    source += literalLength;
    target += literalLength;
    if (source === input.length) break;
    if (source + 2 > input.length) throw new Error("Invalid LZ4 match offset");
    const offset = input[source]! | (input[source + 1]! << 8);
    source += 2;
    if (offset === 0 || offset > target) throw new Error("Invalid LZ4 match");
    const matchLength = length(token & 0x0f) + 4;
    if (target + matchLength > output.length) {
      throw new Error("Invalid LZ4 output length");
    }
    for (let index = 0; index < matchLength; index += 1) {
      output[target] = output[target - offset]!;
      target += 1;
    }
  }
  if (target !== expectedLength) throw new Error("LZ4 chunk length mismatch");
  return output;
}

function interleavedU32(reader: Reader, count: number): number[] {
  const bytes = reader.bytes(count * 4);
  return Array.from({ length: count }, (_, index) => (
    ((bytes[index]! << 24) |
      (bytes[count + index]! << 16) |
      (bytes[count * 2 + index]! << 8) |
      bytes[count * 3 + index]!) >>> 0
  ));
}

function references(reader: Reader, count: number): number[] {
  const encoded = interleavedU32(reader, count);
  let previous = 0;
  return encoded.map((value) => {
    const delta = (value >>> 1) ^ -(value & 1);
    previous += delta;
    return previous;
  });
}

function pathFor(id: number, instances: Map<number, InstanceRecord>): string {
  const names: string[] = [];
  const visited = new Set<number>();
  let current: number | undefined = id;
  while (current !== undefined && current !== -1 && !visited.has(current)) {
    visited.add(current);
    const instance = instances.get(current);
    if (!instance) break;
    if (instance.className !== "DataModel") {
      names.push(instance.name?.trim() || instance.className);
    }
    current = instance.parent;
  }
  return names.reverse().join(".");
}

function extractBinaryScripts(body: Buffer): PlaceScript[] {
  const signature = Buffer.from([
    0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21,
    0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!body.subarray(0, signature.length).equals(signature)) {
    throw new Error("Unsupported Roblox binary place signature");
  }
  const reader = new Reader(body);
  reader.bytes(14);
  if (reader.bytes(2).readUInt16LE(0) !== 0) {
    throw new Error("Unsupported Roblox place version");
  }
  const classCount = reader.u32();
  const instanceCount = reader.u32();
  reader.bytes(8);
  if (classCount > 10_000 || instanceCount > 2_000_000) {
    throw new Error("Roblox place exceeds parser safety limits");
  }

  const classes = new Map<number, { ids: number[]; name: string }>();
  const instances = new Map<number, InstanceRecord>();
  const sharedStrings: string[] = [];
  let ended = false;

  while (reader.offset < body.length) {
    const kind = reader.bytes(4).toString("ascii");
    const compressedLength = reader.u32();
    const uncompressedLength = reader.u32();
    reader.bytes(4);
    const encoded = reader.bytes(compressedLength || uncompressedLength);
    const payload = compressedLength
      ? lz4Block(encoded, uncompressedLength)
      : encoded;
    const chunk = new Reader(payload);

    if (kind === "SSTR") {
      if (chunk.i32() !== 0) throw new Error("Unsupported shared string version");
      const count = chunk.u32();
      if (count > 2_000_000) throw new Error("Too many shared strings");
      for (let index = 0; index < count; index += 1) {
        chunk.bytes(16);
        sharedStrings.push(chunk.string());
      }
    } else if (kind === "INST") {
      const classId = chunk.i32();
      const className = chunk.string(256);
      const hasService = chunk.u8() !== 0;
      const count = chunk.u32();
      const ids = references(chunk, count);
      if (hasService) chunk.bytes(count);
      classes.set(classId, { ids, name: className });
      for (const id of ids) instances.set(id, { className });
    } else if (kind === "PROP") {
      const classId = chunk.i32();
      const property = chunk.string(256);
      const classRecord = classes.get(classId);
      if (!classRecord) throw new Error("Roblox property references unknown class");
      const type = chunk.u8();
      if ((property === "Name" || property === "Source") && type === 0x01) {
        for (const id of classRecord.ids) {
          const value = chunk.string();
          const instance = instances.get(id);
          if (instance) {
            if (property === "Name") instance.name = value;
            else instance.source = value;
          }
        }
      } else if (
        (property === "Name" || property === "Source") &&
        type === 0x1c
      ) {
        const indices = interleavedU32(chunk, classRecord.ids.length);
        for (let index = 0; index < classRecord.ids.length; index += 1) {
          const instance = instances.get(classRecord.ids[index]!);
          const value = sharedStrings[indices[index]!];
          if (instance && value !== undefined) {
            if (property === "Name") instance.name = value;
            else instance.source = value;
          }
        }
      }
    } else if (kind === "PRNT") {
      chunk.u8();
      const count = chunk.u32();
      const children = references(chunk, count);
      const parents = references(chunk, count);
      for (let index = 0; index < count; index += 1) {
        const instance = instances.get(children[index]!);
        if (instance) instance.parent = parents[index]!;
      }
    } else if (kind === "END\u0000") {
      ended = true;
      break;
    }
  }
  if (!ended) throw new Error("Roblox place is missing its END chunk");

  const scriptClasses = new Set(["Script", "LocalScript", "ModuleScript"]);
  return [...instances.entries()]
    .filter(([, value]) => scriptClasses.has(value.className))
    .map(([id, value]) => ({
      className: value.className as ScriptClass,
      name: value.name?.trim() || value.className,
      path: pathFor(id, instances),
      source: value.source ?? "",
    }))
    .filter((script) => script.path && script.source)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlScripts(body: Buffer): PlaceScript[] {
  const xml = body.toString("utf8");
  const scripts: PlaceScript[] = [];
  const stack: Array<{ className: string; name: string }> = [];
  const token = /<Item\b[^>]*class="([^"]+)"[^>]*>|<\/Item>|<string name="(Name|Source)">([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml))) {
    if (match[1]) {
      stack.push({ className: match[1], name: match[1] });
    } else if (match[0] === "</Item>") {
      const item = stack.pop();
      if (
        item &&
        (item.className === "Script" ||
          item.className === "LocalScript" ||
          item.className === "ModuleScript") &&
        (item as typeof item & { source?: string }).source
      ) {
        scripts.push({
          className: item.className,
          name: item.name,
          path: [...stack, item]
            .filter((entry) => entry.className !== "DataModel")
            .map((entry) => entry.name)
            .join("."),
          source: (item as typeof item & { source: string }).source,
        });
      }
    } else if (stack.length && match[2]) {
      const raw = match[3]!.replace(/^<!\[CDATA\[|\]\]>$/g, "");
      const value = decodeXml(raw);
      const item = stack[stack.length - 1]!;
      if (match[2] === "Name") item.name = value;
      else (item as typeof item & { source?: string }).source = value;
    }
  }
  return scripts;
}

export function extractScriptsFromPlace(body: Buffer): PlaceScript[] {
  if (body.subarray(0, 8).toString("ascii") === "<roblox!") {
    return extractBinaryScripts(body);
  }
  const xmlPrefix = body.subarray(0, 512).toString("utf8").replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?<roblox\b/.test(xmlPrefix)) {
    return extractXmlScripts(body);
  }
  throw new Error("Unsupported Roblox place file");
}
