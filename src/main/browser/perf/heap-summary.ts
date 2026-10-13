// A compact reading of a V8 heap snapshot: what holds the memory (retained
// sizes from the dominator tree, as DevTools' Memory panel computes them),
// which classes are largest, and detached DOM. Runs in a worker (worker.ts),
// so the function below is self-contained. The node and edge arrays are
// parsed straight into typed arrays: JSON.parse of a large snapshot would
// need several times the file's size in heap.

export interface HeapSummaryInput {
  path: string;
  maxBytes: number;
  /** Above this many nodes only class totals are computed, no retained sizes. */
  maxNodesForRetained: number;
}

export interface HeapClassRow {
  name: string;
  count: number;
  selfBytes: number;
  retainedBytes?: number;
}

export interface HeapObjectRow {
  name: string;
  id: number;
  selfBytes: number;
  retainedBytes: number;
  path: string;
}

export interface HeapSummary {
  nodes: number;
  edges: number;
  totalBytes: number;
  classes: HeapClassRow[];
  retainers: HeapObjectRow[];
  detached: { count: number; retainedBytes: number; top: string[] };
  note?: string;
}

export function summarizeHeapSnapshotFile(input: HeapSummaryInput): HeapSummary {
  const fs = require("node:fs") as typeof import("node:fs");
  const size = fs.statSync(input.path).size;
  const empty: HeapSummary = { nodes: 0, edges: 0, totalBytes: 0, classes: [], retainers: [], detached: { count: 0, retainedBytes: 0, top: [] } };
  if (size > input.maxBytes) return { ...empty, note: `The snapshot is ${Math.round(size / 1048576)} MB; open it in DevTools for details.` };

  const fd = fs.openSync(input.path, "r");
  const CHUNK = 4 << 20;
  const buffer = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  let offset = 0;
  let filePos = 0;
  const fill = () => {
    bytes = fs.readSync(fd, buffer, 0, CHUNK, filePos);
    filePos += bytes;
    offset = 0;
    return bytes > 0;
  };
  try {
    // The header, up to the nodes array.
    let head = "";
    let marker = -1;
    while (marker < 0 && fill()) {
      head += buffer.toString("latin1", 0, bytes);
      marker = head.indexOf('"nodes":[');
      if (head.length > 64 << 20) break;
    }
    if (marker < 0) throw new Error("not a heap snapshot");
    const header = JSON.parse(head.slice(0, head.lastIndexOf(",", marker)) + "}") as {
      snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]]; edge_fields: string[]; edge_types: [string[], ...unknown[]] }; node_count: number; edge_count: number };
    };
    const meta = header.snapshot.meta;
    const nodeFieldCount = meta.node_fields.length;
    const edgeFieldCount = meta.edge_fields.length;
    const nodeCount = header.snapshot.node_count;
    const edgeCount = header.snapshot.edge_count;
    const nodes = new Uint32Array(nodeCount * nodeFieldCount);
    const edges = new Uint32Array(edgeCount * edgeFieldCount);
    // Resume parsing right after `"nodes":[` in the file.
    filePos = Buffer.byteLength(head.slice(0, marker + '"nodes":['.length), "latin1");
    fill();

    const readNumbers = (target: Uint32Array) => {
      let index = 0;
      let value = 0;
      let inNumber = false;
      for (;;) {
        if (offset >= bytes && !fill()) throw new Error("the snapshot is cut short");
        const byte = buffer[offset++];
        if (byte >= 48 && byte <= 57) {
          value = value * 10 + (byte - 48);
          inNumber = true;
        } else {
          if (inNumber) {
            if (index < target.length) target[index] = value;
            index += 1;
            value = 0;
            inNumber = false;
          }
          if (byte === 93) return index;
        }
      }
    };
    const skipTo = (text: string) => {
      const pattern = Buffer.from(text, "latin1");
      let matched = 0;
      for (;;) {
        if (offset >= bytes && !fill()) throw new Error(`no ${text} in the snapshot`);
        const byte = buffer[offset++];
        matched = byte === pattern[matched] ? matched + 1 : byte === pattern[0] ? 1 : 0;
        if (matched === pattern.length) return;
      }
    };
    readNumbers(nodes);
    skipTo('"edges":[');
    readNumbers(edges);
    skipTo('"strings":[');
    // The string table closes the file; it is the one part parsed as JSON.
    const rest: Buffer[] = [buffer.subarray(offset, bytes)];
    let restBytes = bytes - offset;
    const tail = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const read = fs.readSync(fd, tail, 0, CHUNK, filePos);
      if (read <= 0) break;
      filePos += read;
      rest.push(Buffer.from(tail.subarray(0, read)));
      restBytes += read;
    }
    const restText = Buffer.concat(rest, restBytes).toString("utf8");
    const strings = JSON.parse("[" + restText.slice(0, restText.lastIndexOf("]") + 1)) as string[];

    const field = (name: string) => meta.node_fields.indexOf(name);
    const TYPE = field("type");
    const NAME = field("name");
    const ID = field("id");
    const SELF = field("self_size");
    const EDGES = field("edge_count");
    const DETACHED = field("detachedness");
    const EDGE_TYPE = meta.edge_fields.indexOf("type");
    const EDGE_NAME = meta.edge_fields.indexOf("name_or_index");
    const EDGE_TO = meta.edge_fields.indexOf("to_node");
    const nodeTypes = meta.node_types[0];
    const edgeTypes = meta.edge_types[0];
    const typeIndex = (name: string) => nodeTypes.indexOf(name);
    const edgeIndex = (name: string) => edgeTypes.indexOf(name);
    const SYNTHETIC = typeIndex("synthetic");
    const HIDDEN = typeIndex("hidden");
    const WEAK = edgeIndex("weak");
    const SHORTCUT = edgeIndex("shortcut");
    const ELEMENT = edgeIndex("element");
    const HIDDEN_EDGE = edgeIndex("hidden");

    const firstEdge = new Uint32Array(nodeCount + 1);
    for (let ordinal = 0, edge = 0; ordinal < nodeCount; ordinal += 1) {
      firstEdge[ordinal] = edge;
      edge += nodes[ordinal * nodeFieldCount + EDGES] * edgeFieldCount;
    }
    firstEdge[nodeCount] = edgeCount * edgeFieldCount;

    const CLASS_BY_TYPE: Record<string, string> = {
      string: "(string)",
      "concatenated string": "(string)",
      "sliced string": "(string)",
      code: "(compiled code)",
      array: "(array)",
      hidden: "(system)",
      number: "(number)",
      "heap number": "(number)",
      symbol: "(symbol)",
      bigint: "(bigint)",
      regexp: "(regexp)",
      closure: "(closure)",
      "object shape": "(object shape)",
    };
    const className = (ordinal: number) => {
      const base = ordinal * nodeFieldCount;
      const type = nodeTypes[nodes[base + TYPE]] ?? "unknown";
      if (type === "object" || type === "native" || type === "synthetic") {
        const name = strings[nodes[base + NAME]] ?? "";
        // "Window / http://host" and "Window [JSGlobalObject]" name one class.
        return name.replace(/ \/ .*$/, "").replace(/ \[JSGlobalObject\]$/, "") || `(${type})`;
      }
      return CLASS_BY_TYPE[type] ?? `(${type})`;
    };
    const isDetached = (ordinal: number) => {
      const base = ordinal * nodeFieldCount;
      if (DETACHED >= 0 && nodes[base + DETACHED] === 2) return true;
      return (strings[nodes[base + NAME]] ?? "").startsWith("Detached ");
    };

    const classes = new Map<string, HeapClassRow>();
    let totalSelf = 0;
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
      const base = ordinal * nodeFieldCount;
      const self = nodes[base + SELF];
      totalSelf += self;
      if (nodes[base + TYPE] === SYNTHETIC) continue;
      const name = className(ordinal);
      const row = classes.get(name);
      if (row) {
        row.count += 1;
        row.selfBytes += self;
      } else classes.set(name, { name, count: 1, selfBytes: self });
    }

    const result: HeapSummary = { nodes: nodeCount, edges: edgeCount, totalBytes: totalSelf, classes: [], retainers: [], detached: { count: 0, retainedBytes: 0, top: [] } };
    const detachedNames = new Map<string, number>();
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
      if (!isDetached(ordinal)) continue;
      result.detached.count += 1;
      const name = strings[nodes[ordinal * nodeFieldCount + NAME]] ?? "";
      detachedNames.set(name, (detachedNames.get(name) ?? 0) + 1);
    }
    result.detached.top = [...detachedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name.startsWith("Detached ") ? name : `Detached ${name}`} x${count}`);

    if (nodeCount > input.maxNodesForRetained) {
      result.classes = [...classes.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 10);
      result.note = `${nodeCount} nodes: retained sizes skipped; open the file in DevTools for them.`;
      return result;
    }

    // Dominator tree (Cooper, Harvey and Kennedy), over the edges DevTools
    // treats as essential: weak edges never retain, and shortcut edges only
    // from the root, where they mark user globals.
    const ROOT = 0;
    const essential = (from: number, type: number) => type !== WEAK && (type !== SHORTCUT || from === ROOT);
    const retainerCount = new Uint32Array(nodeCount + 1);
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
      for (let edge = firstEdge[ordinal]; edge < firstEdge[ordinal + 1]; edge += edgeFieldCount) {
        if (!essential(ordinal, edges[edge + EDGE_TYPE])) continue;
        retainerCount[edges[edge + EDGE_TO] / nodeFieldCount] += 1;
      }
    }
    const firstRetainer = new Uint32Array(nodeCount + 1);
    for (let ordinal = 0, sum = 0; ordinal < nodeCount; ordinal += 1) {
      firstRetainer[ordinal] = sum;
      sum += retainerCount[ordinal];
      if (ordinal === nodeCount - 1) firstRetainer[nodeCount] = sum;
    }
    const retainers = new Uint32Array(firstRetainer[nodeCount]);
    retainerCount.fill(0);
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
      for (let edge = firstEdge[ordinal]; edge < firstEdge[ordinal + 1]; edge += edgeFieldCount) {
        if (!essential(ordinal, edges[edge + EDGE_TYPE])) continue;
        const to = edges[edge + EDGE_TO] / nodeFieldCount;
        retainers[firstRetainer[to] + retainerCount[to]++] = ordinal;
      }
    }

    const postOrder = new Uint32Array(nodeCount);
    const orderOf = new Uint32Array(nodeCount);
    const visited = new Uint8Array(nodeCount);
    const stackNodes = new Uint32Array(nodeCount);
    const stackEdges = new Uint32Array(nodeCount);
    let order = 0;
    let top = 0;
    stackNodes[0] = ROOT;
    stackEdges[0] = firstEdge[ROOT];
    visited[ROOT] = 1;
    while (top >= 0) {
      const ordinal = stackNodes[top];
      const edge = stackEdges[top];
      if (edge < firstEdge[ordinal + 1]) {
        stackEdges[top] += edgeFieldCount;
        if (!essential(ordinal, edges[edge + EDGE_TYPE])) continue;
        const to = edges[edge + EDGE_TO] / nodeFieldCount;
        if (visited[to]) continue;
        visited[to] = 1;
        top += 1;
        stackNodes[top] = to;
        stackEdges[top] = firstEdge[to];
      } else {
        orderOf[ordinal] = order;
        postOrder[order++] = ordinal;
        top -= 1;
      }
    }
    // Nodes nothing essential reaches hang off the root, before it in post order.
    const rootOrder = nodeCount - 1;
    if (order < nodeCount) {
      // The root, popped last, moves to the end to make room.
      order -= 1;
      for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
        if (visited[ordinal]) continue;
        orderOf[ordinal] = order;
        postOrder[order++] = ordinal;
      }
      orderOf[ROOT] = rootOrder;
      postOrder[rootOrder] = ROOT;
    }
    const NONE = 0xffffffff;
    const dominator = new Uint32Array(nodeCount).fill(NONE);
    dominator[rootOrder] = rootOrder;
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) if (!visited[ordinal]) dominator[orderOf[ordinal]] = rootOrder;
    const affected = new Uint8Array(nodeCount);
    for (let edge = firstEdge[ROOT]; edge < firstEdge[ROOT + 1]; edge += edgeFieldCount) {
      if (essential(ROOT, edges[edge + EDGE_TYPE])) affected[orderOf[edges[edge + EDGE_TO] / nodeFieldCount]] = 1;
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let current = rootOrder - 1; current >= 0; current -= 1) {
        if (!affected[current]) continue;
        affected[current] = 0;
        if (dominator[current] === rootOrder) continue;
        const ordinal = postOrder[current];
        let next = NONE;
        for (let r = firstRetainer[ordinal]; r < firstRetainer[ordinal + 1]; r += 1) {
          let candidate = orderOf[retainers[r]];
          if (dominator[candidate] === NONE) continue;
          if (next === NONE) next = candidate;
          else {
            while (candidate !== next) {
              while (candidate < next) candidate = dominator[candidate];
              while (next < candidate) next = dominator[next];
            }
          }
          if (next === rootOrder) break;
        }
        if (next !== NONE && dominator[current] !== next) {
          dominator[current] = next;
          changed = true;
          for (let edge = firstEdge[ordinal]; edge < firstEdge[ordinal + 1]; edge += edgeFieldCount) {
            affected[orderOf[edges[edge + EDGE_TO] / nodeFieldCount]] = 1;
          }
        }
      }
    }

    const retained = new Float64Array(nodeCount);
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) retained[ordinal] = nodes[ordinal * nodeFieldCount + SELF];
    for (let current = 0; current < rootOrder; current += 1) {
      const ordinal = postOrder[current];
      const dom = dominator[current];
      if (dom === NONE) continue;
      retained[postOrder[dom]] += retained[ordinal];
    }
    const dominatorOf = (ordinal: number) => {
      const dom = dominator[orderOf[ordinal]];
      return dom === NONE ? ROOT : postOrder[dom];
    };
    result.totalBytes = retained[ROOT];

    // A class's retained size counts an object unless its dominator is of the same class.
    for (let ordinal = 1; ordinal < nodeCount; ordinal += 1) {
      const base = ordinal * nodeFieldCount;
      if (nodes[base + TYPE] === SYNTHETIC) continue;
      const name = className(ordinal);
      const parent = dominatorOf(ordinal);
      if (parent !== ROOT && className(parent) === name) continue;
      const row = classes.get(name)!;
      row.retainedBytes = (row.retainedBytes ?? 0) + retained[ordinal];
      if (isDetached(ordinal) && !isDetached(parent)) result.detached.retainedBytes += retained[ordinal];
    }
    result.classes = [...classes.values()].sort((a, b) => (b.retainedBytes ?? 0) - (a.retainedBytes ?? 0)).slice(0, 10);

    const edgeLabel = (from: number, to: number) => {
      for (let edge = firstEdge[from]; edge < firstEdge[from + 1]; edge += edgeFieldCount) {
        if (edges[edge + EDGE_TO] / nodeFieldCount !== to) continue;
        const type = edges[edge + EDGE_TYPE];
        const name = edges[edge + EDGE_NAME];
        return type === ELEMENT || type === HIDDEN_EDGE ? `[${name}]` : `.${strings[name] ?? "?"}`;
      }
      return null;
    };
    const chainTo = (ordinal: number, depth: number) => {
      const chain = [ordinal];
      for (let node = ordinal; chain.length <= depth; ) {
        const parent = dominatorOf(node);
        if (parent === ROOT || nodes[parent * nodeFieldCount + TYPE] === SYNTHETIC) break;
        chain.unshift(parent);
        node = parent;
      }
      return chain;
    };
    const pathTo = (ordinal: number) => {
      const chain = chainTo(ordinal, 4);
      let text = className(chain[0]);
      for (let index = 1; index < chain.length; index += 1) {
        text += edgeLabel(chain[index - 1], chain[index]) ?? ` > ${className(chain[index])}`;
      }
      return text;
    };
    // Objects that hold everything (the global, the document) say nothing about a leak.
    // Internal backing stores ("(array)") are listed through the object that owns them.
    const UMBRELLAS = new Set(["Window", "global", "JSGlobalProxy", "HTMLDocument", "Document", "(system)", "(array)", "(compiled code)", "(object shape)", "(string)", "(number)"]);
    const candidates: number[] = [];
    for (let ordinal = 1; ordinal < nodeCount; ordinal += 1) {
      const type = nodes[ordinal * nodeFieldCount + TYPE];
      if (type === SYNTHETIC || type === HIDDEN) continue;
      const name = className(ordinal);
      if (UMBRELLAS.has(name) || name.startsWith("system /")) continue;
      candidates.push(ordinal);
    }
    candidates.sort((a, b) => retained[b] - retained[a]);
    // An object inside one already listed would repeat its size.
    const chosen = new Set<number>();
    for (const ordinal of candidates) {
      // Below 1% of the heap an object is not what holds the memory.
      if (chosen.size >= 8 || retained[ordinal] <= 0 || (chosen.size > 0 && retained[ordinal] < retained[ROOT] / 100)) break;
      const chain = chainTo(ordinal, 8);
      if (chain.some((node) => chosen.has(node))) continue;
      // V8's and Blink's own caches are not the page's doing.
      if (chain.length > 1 && nodes[chain[0] * nodeFieldCount + TYPE] === HIDDEN) continue;
      chosen.add(ordinal);
    }
    result.retainers = [...chosen].map((ordinal) => ({
      name: className(ordinal),
      id: nodes[ordinal * nodeFieldCount + ID],
      selfBytes: nodes[ordinal * nodeFieldCount + SELF],
      retainedBytes: retained[ordinal],
      path: pathTo(ordinal),
    }));
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
