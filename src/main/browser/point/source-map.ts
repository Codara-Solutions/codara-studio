// Maps a position in served code (a React 19 owner-stack frame) back to the
// file the developer wrote, through the script's source map: inline (Vite
// serves every module with one), a sibling .map file, or an index map with
// sections (Turbopack). Only what the picker needs is implemented: decoding
// "mappings" and finding the segment at one line and column.

export interface OriginalPosition {
  /** The map's source entry, unresolved (webpack://, /abs/path, ../src/App.tsx, ...). */
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The map's own URL, for resolving a relative source. */
  mapUrl: string;
  sourceRoot: string;
}

interface RawMap {
  version?: number;
  sources?: string[];
  sourceRoot?: string;
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map?: RawMap; url?: string }>;
}

/** Segments per generated line: [generatedColumn, sourceIndex, originalLine, originalColumn], all 0-based. */
type DecodedLine = Array<[number, number, number, number]>;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((ch, i) => [ch, i]));

export function decodeMappings(mappings: string): DecodedLine[] {
  const lines: DecodedLine[] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const lineText of mappings.split(";")) {
    const line: DecodedLine = [];
    let generatedColumn = 0;
    for (const segmentText of lineText.split(",")) {
      if (!segmentText) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segmentText) {
        const digit = BASE64_VALUE.get(ch);
        if (digit === undefined) throw new Error(`bad source map character ${JSON.stringify(ch)}`);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      generatedColumn += values[0] ?? 0;
      if (values.length >= 4) {
        source += values[1];
        originalLine += values[2];
        originalColumn += values[3];
        line.push([generatedColumn, source, originalLine, originalColumn]);
      }
    }
    lines.push(line);
  }
  return lines;
}

export class SourceMapLookup {
  private decoded: DecodedLine[] | null = null;

  constructor(private readonly map: RawMap, readonly mapUrl: string) {}

  /** line and column are 1-based, as stack frames report them. */
  original(line: number, column: number): OriginalPosition | null {
    if (Array.isArray(this.map.sections)) {
      let chosen: (typeof this.map.sections)[number] | null = null;
      for (const section of this.map.sections) {
        const { line: l, column: c } = section.offset;
        if (l < line - 1 || (l === line - 1 && c <= column - 1)) chosen = section;
      }
      if (!chosen?.map) return null;
      const startLine = chosen.offset.line;
      const inner = new SourceMapLookup(chosen.map, this.mapUrl);
      const innerLine = line - startLine;
      const innerColumn = innerLine === 1 ? column - chosen.offset.column : column;
      return inner.original(innerLine, innerColumn);
    }
    if (typeof this.map.mappings !== "string" || !Array.isArray(this.map.sources)) return null;
    this.decoded ??= decodeMappings(this.map.mappings);
    const segments = this.decoded[line - 1];
    if (!segments?.length) return null;
    let best: DecodedLine[number] | null = null;
    for (const segment of segments) {
      if (segment[0] <= column - 1) best = segment;
      else break;
    }
    best ??= segments[0];
    const source = this.map.sources[best[1]];
    if (typeof source !== "string") return null;
    return { source, line: best[2] + 1, column: best[3] + 1, mapUrl: this.mapUrl, sourceRoot: this.map.sourceRoot ?? "" };
  }
}

const SOURCE_MAP_URL = /\/[/*][#@]\s*sourceMappingURL=([^\s*'"]+)\s*(?:\*\/)?\s*$/;

/** The sourceMappingURL comment at the end of a script, resolved against the script URL. */
export function sourceMappingUrl(code: string, scriptUrl: string): string | null {
  const tail = code.slice(-4096).trimEnd();
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const match = SOURCE_MAP_URL.exec(lines[i].trim());
    if (!match) continue;
    if (match[1].startsWith("data:")) return match[1];
    try {
      return new URL(match[1], scriptUrl).href;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseDataUrlJson(url: string): RawMap | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const text = /;base64/i.test(meta) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  return JSON.parse(text) as RawMap;
}

export type TextFetcher = (url: string) => Promise<string | null>;

/** Fetches scripts and maps for the lookups, keeping the last few. */
export class SourceMapResolver {
  private readonly cache = new Map<string, Promise<SourceMapLookup | null>>();

  constructor(private readonly fetchText: TextFetcher, private readonly capacity = 24) {}

  async lookup(scriptUrl: string): Promise<SourceMapLookup | null> {
    const key = scriptUrl;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.load(scriptUrl).catch(() => null);
      this.cache.set(key, pending);
      while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value as string);
    }
    return pending;
  }

  async original(scriptUrl: string, line: number, column: number): Promise<OriginalPosition | null> {
    const lookup = await this.lookup(scriptUrl);
    return lookup?.original(line, column) ?? null;
  }

  private async load(scriptUrl: string): Promise<SourceMapLookup | null> {
    const code = await this.fetchText(scriptUrl);
    if (!code) return null;
    const mapUrl = sourceMappingUrl(code, scriptUrl);
    if (!mapUrl) return null;
    if (mapUrl.startsWith("data:")) return new SourceMapLookup(parseDataUrlJson(mapUrl) ?? {}, scriptUrl);
    const text = await this.fetchText(mapUrl);
    return text ? new SourceMapLookup(JSON.parse(text) as RawMap, mapUrl) : null;
  }
}
