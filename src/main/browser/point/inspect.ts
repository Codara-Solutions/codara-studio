// Inspects elements on any BrowserTarget for pointing at the page: runs the
// page probe (src/shared/preview-point.ts), maps its source hints to files in
// the workspace (through source maps when the page only knows served code),
// falls back to a workspace search, and crops each element out of one
// viewport capture. The picker, comments on the page and
// codara_preview_inspect all go through inspectPage.

import { promises as fs } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { PointInspection, ResolvedSource, InspectedElement, InspectedRegion, PointCrop } from "../../../shared/point-format";
import { pointProbe, type PointProbeArgs, type PointProbeResult, type PointSourceHint, type PointRegionInput } from "../../../shared/preview-point";
import { writeBrowserArtifact } from "../artifacts";
import { runLocator } from "../locator";
import { cssRectToImage, nativeImageCodec, outputSize, type ImageCodec } from "../screenshot";
import type { BrowserTarget } from "../targets";
import { SourceMapResolver, type TextFetcher } from "./source-map";
import { locateSourceFile, nodeWorkspaceFiles, searchWorkspaceSources, sourcePathFromUrl, type WorkspaceFiles } from "./source-files";

export const MAX_INSPECTED_ELEMENTS = 12;
export const MAX_REGIONS = 20;
const MAX_CROPS = 6;
const MAX_SEARCHES = 4;
const CROP_PADDING = 8;
const CROP_MAX_WIDTH = 640;
const MAX_SCRIPT_BYTES = 15 * 1024 * 1024;

export interface PointInspectRequest {
  selectors?: string[];
  regions?: PointRegionInput[];
  /** An attribute the picker set on the elements; the probe removes it. */
  clearAttribute?: string;
  /** "data" returns the crops' bytes, "file" saves them, "both" does both. Default none. */
  crops?: "none" | "data" | "file" | "both";
  /** The workspace folder, for resolving and searching sources; null skips both. */
  workspaceRoot?: string | null;
  /** Search the workspace when the page names no file. Default true. */
  search?: boolean;
}

export interface PointInspectDeps {
  resolver?: SourceMapResolver;
  files?: WorkspaceFiles;
  codec?: ImageCodec;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Reads a script or map the page named: over http(s), or from disk for a
 * file:// page inside the workspace. Bounded in time and size.
 */
export function pointTextFetcher(workspaceRoot: string | null): TextFetcher {
  return async (url) => {
    if (/^file:/i.test(url)) {
      if (!workspaceRoot) return null;
      let path: string;
      try {
        path = fileURLToPath(url);
      } catch {
        return null;
      }
      if (!inside(workspaceRoot, path)) return null;
      const stat = await fs.stat(path).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
      return fs.readFile(path, "utf8").catch(() => null);
    }
    if (!/^https?:/i.test(url)) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "follow" }).catch(() => null);
    if (!response?.ok) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_SCRIPT_BYTES) return null;
    const text = await response.text().catch(() => null);
    return text && text.length <= MAX_SCRIPT_BYTES ? text : null;
  };
}

const resolvers = new Map<string, SourceMapResolver>();

function defaultResolver(workspaceRoot: string | null): SourceMapResolver {
  const key = workspaceRoot ?? "";
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = new SourceMapResolver(pointTextFetcher(workspaceRoot));
    resolvers.set(key, resolver);
    while (resolvers.size > 8) resolvers.delete(resolvers.keys().next().value as string);
  }
  return resolver;
}

async function resolveHint(hint: PointSourceHint, root: string | null, resolver: SourceMapResolver): Promise<ResolvedSource> {
  let path = sourcePathFromUrl(hint.file);
  let line = hint.line;
  let column = hint.column;
  if (hint.generated && /^(https?|file):/i.test(hint.file) && line) {
    const original = await resolver.original(hint.file, line, column ?? 1).catch(() => null);
    if (original) {
      path = sourcePathFromUrl(original.source, original.sourceRoot, original.mapUrl);
      line = original.line;
      column = original.column;
    }
  }
  const located = await locateSourceFile(path, root);
  return {
    file: located.file,
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    via: hint.via,
    ...(hint.component ? { component: hint.component } : {}),
    exists: located.exists,
  };
}

async function resolveHints(hints: readonly PointSourceHint[], root: string | null, resolver: SourceMapResolver): Promise<ResolvedSource[]> {
  const out: ResolvedSource[] = [];
  for (const hint of hints) {
    const resolved = await resolveHint(hint, root, resolver);
    if (!out.some((seen) => seen.file === resolved.file && seen.line === resolved.line)) out.push(resolved);
  }
  return out;
}

function best(sources: readonly ResolvedSource[]): ResolvedSource | null {
  return sources.find((source) => source.exists) ?? null;
}

async function crops(
  target: BrowserTarget,
  probe: PointProbeResult,
  mode: NonNullable<PointInspectRequest["crops"]>,
  codec: ImageCodec,
): Promise<Map<number, PointCrop>> {
  const out = new Map<number, PointCrop>();
  const wanted = probe.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.box.visible && element.box.inViewport && element.box.width >= 1 && element.box.height >= 1)
    .slice(0, MAX_CROPS);
  if (mode === "none" || !wanted.length) return out;
  const png = await target.captureViewport();
  const image = codec.size(png);
  const viewport = probe.viewport.width > 0 ? probe.viewport : image;
  for (const { element, index } of wanted) {
    const rect = {
      x: element.box.x - CROP_PADDING,
      y: element.box.y - CROP_PADDING,
      width: element.box.width + CROP_PADDING * 2,
      height: element.box.height + CROP_PADDING * 2,
    };
    const crop = cssRectToImage(rect, viewport, image);
    if (!crop) continue;
    let cropped = codec.crop(png, crop);
    const css = { width: crop.width * (viewport.width / image.width), height: crop.height * (viewport.height / image.height) };
    const size = outputSize(css, Math.min(2, probe.devicePixelRatio || 1), CROP_MAX_WIDTH);
    const current = codec.size(cropped);
    if (current.width !== size.width || current.height !== size.height) cropped = codec.resize(cropped, size);
    const encoded = await codec.encode(cropped, "jpeg", 80);
    const path = mode === "file" || mode === "both"
      ? await writeBrowserArtifact(target.workspaceId, "screenshots", { label: `${target.ref}-element-${index + 1}`, ext: "jpg", data: encoded })
      : null;
    out.set(index, { mimeType: "image/jpeg", path, ...(mode === "data" || mode === "both" ? { data: encoded.toString("base64") } : {}) });
  }
  return out;
}

export async function inspectPage(target: BrowserTarget, request: PointInspectRequest, deps: PointInspectDeps = {}): Promise<PointInspection> {
  const selectors = (request.selectors ?? []).filter((value) => typeof value === "string" && value.trim()).slice(0, MAX_INSPECTED_ELEMENTS);
  const regions = (request.regions ?? []).slice(0, MAX_REGIONS);
  const args: PointProbeArgs = { selectors, regions, ...(request.clearAttribute ? { clearAttribute: request.clearAttribute } : {}) };
  const probe = await runLocator(target, pointProbe, args);
  const root = request.workspaceRoot ?? null;
  const resolver = deps.resolver ?? defaultResolver(root);
  const files = deps.files ?? nodeWorkspaceFiles;
  const cropMap = await crops(target, probe, request.crops ?? "none", deps.codec ?? nativeImageCodec()).catch(() => new Map<number, PointCrop>());

  const elements: InspectedElement[] = [];
  let searches = 0;
  for (const [index, element] of probe.elements.entries()) {
    const sources = await resolveHints(element.sources, root, resolver);
    const source = best(sources);
    let candidates: InspectedElement["candidates"] = [];
    if (!source && root && request.search !== false && searches < MAX_SEARCHES) {
      searches++;
      candidates = (await searchWorkspaceSources(root, { ...element.hints, components: element.components }, files).catch(() => []))
        .map(({ file, line, reason }) => ({ file, line, reason }));
    }
    const crop = cropMap.get(index);
    const rules = element.rules.map((rule) => ({ ...rule, source: rule.source && root && isAbsolute(rule.source) && inside(root, rule.source) ? relative(root, rule.source).split(sep).join("/") : rule.source }));
    elements.push({ ...element, rules, source, sources, candidates, ...(crop ? { crop } : {}) });
  }

  const inspectedRegions: InspectedRegion[] = [];
  for (const region of probe.regions) {
    const resolved = [];
    for (const element of region.elements) {
      const { sources, ...rest } = element;
      const mapped = await resolveHints(sources, root, resolver);
      resolved.push({ ...rest, source: best(mapped) });
    }
    inspectedRegions.push({ ...region, elements: resolved });
  }

  return {
    tabId: target.ref,
    url: probe.url,
    title: probe.title,
    viewport: probe.viewport,
    scroll: probe.scroll,
    devicePixelRatio: probe.devicePixelRatio,
    elements,
    regions: inspectedRegions,
    missing: probe.missing,
  };
}
