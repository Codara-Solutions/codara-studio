// Accessibility audit with axe-core, injected into the insight world. It
// needs no DevTools window and no focus, so it runs on a background tab, a
// hidden tab and with Codara minimized.

import { readFileSync } from "node:fs";

import { writeBrowserArtifact } from "../artifacts";
import type { BrowserTarget } from "../targets";
import { evaluateInWorld, refsForSelectors } from "./world";

const RULE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"];
const NODES_KEPT_PER_RULE = 50;
const RULES_SHOWN = 12;
const ELEMENTS_SHOWN_PER_RULE = 5;

let axeSource: string | null = null;

function loadAxeSource(): string {
  axeSource ??= readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

export interface AxeNode {
  target: Array<string | string[]>;
  html: string;
  summary: string;
  contrast?: {
    ratio: number;
    expected: number;
    foreground: string;
    background: string;
    fontSize: string;
    fontWeight: string;
  };
}

export interface AxeRule {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  wcag: string[];
  total: number;
  nodes: AxeNode[];
}

export interface AxeRun {
  url: string;
  engine: string;
  violations: AxeRule[];
  incomplete: AxeRule[];
  passes: number;
  inapplicable: number;
}

// Runs in the insight world after axe is defined there. Stringified: it may
// use only its argument and page globals.
function axeProbe(options: { tags: string[]; nodesKept: number }): Promise<AxeRun> {
  type RawCheck = { id: string; data?: Record<string, unknown> | null };
  type RawNode = { target: Array<string | string[]>; html: string; failureSummary?: string; any?: RawCheck[]; all?: RawCheck[]; none?: RawCheck[] };
  type RawRule = { id: string; impact?: string | null; help: string; helpUrl: string; tags: string[]; nodes: RawNode[] };
  type RawResults = { url: string; testEngine: { version: string }; violations: RawRule[]; incomplete: RawRule[]; passes: RawRule[]; inapplicable: RawRule[] };
  const engine = (globalThis as unknown as { axe: { run(context: unknown, options: unknown): Promise<RawResults> } }).axe;
  const compactNode = (node: RawNode) => {
    const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
    const contrast = checks.find((check) => check.id === "color-contrast" || check.id === "color-contrast-enhanced")?.data;
    const out: Record<string, unknown> = {
      target: node.target,
      html: String(node.html ?? "").replace(/\s+/g, " ").slice(0, 160),
      summary: String(node.failureSummary ?? "").replace(/^Fix (any|all) of the following:\s*/i, "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join("; ").slice(0, 300),
    };
    if (contrast && typeof contrast.contrastRatio === "number" && contrast.contrastRatio > 0) {
      out.contrast = {
        ratio: contrast.contrastRatio,
        expected: Number(String(contrast.expectedContrastRatio ?? "").replace(/:1$/, "")) || null,
        foreground: contrast.fgColor ?? null,
        background: contrast.bgColor ?? null,
        fontSize: contrast.fontSize ?? null,
        fontWeight: contrast.fontWeight ?? null,
      };
    }
    return out;
  };
  const compactRule = (rule: RawRule, keep: number) => ({
    id: rule.id,
    impact: rule.impact ?? null,
    help: rule.help,
    helpUrl: rule.helpUrl,
    wcag: rule.tags.filter((tag) => /^wcag\d+$/.test(tag)),
    total: rule.nodes.length,
    nodes: rule.nodes.slice(0, keep).map(compactNode),
  });
  return engine.run(document, {
    runOnly: { type: "tag", values: options.tags },
    resultTypes: ["violations", "incomplete"],
    iframes: false,
    elementRef: false,
    selectors: true,
    ancestry: false,
    xpath: false,
    performanceTimer: false,
  }).then((results) => ({
    url: results.url,
    engine: `axe-core ${results.testEngine.version}`,
    violations: results.violations.map((rule) => compactRule(rule, options.nodesKept)),
    incomplete: results.incomplete.map((rule) => compactRule(rule, 10)),
    passes: results.passes.length,
    inapplicable: results.inapplicable.length,
  })) as unknown as Promise<AxeRun>;
}

async function runAxe(target: BrowserTarget): Promise<AxeRun> {
  const ready = await evaluateInWorld<boolean>(target.session, "typeof axe === 'object' && typeof axe.run === 'function'");
  if (!ready) {
    // Defining axe and running it are two evaluations in the same world; a
    // navigation in between leaves the new document without it, so the run
    // below then fails with a clear message instead of auditing nothing.
    await evaluateInWorld(target.session, `${loadAxeSource()}\n;void 0`);
  }
  const expression = `(typeof axe === 'object' ? (${axeProbe.toString()})(${JSON.stringify({ tags: RULE_TAGS, nodesKept: NODES_KEPT_PER_RULE })}) : Promise.reject(new Error("The page navigated during the audit. Run it again.")))`;
  return evaluateInWorld<AxeRun>(target.session, expression, { awaitPromise: true });
}

function impactRank(impact: string | null): number {
  const rank = IMPACT_ORDER.indexOf(impact ?? "");
  return rank < 0 ? IMPACT_ORDER.length : rank;
}

export function formatContrast(contrast: NonNullable<AxeNode["contrast"]>): string {
  const ratio = [`${Math.floor(contrast.ratio * 100) / 100}:1`, contrast.expected ? `needs ${contrast.expected}:1` : ""].filter(Boolean).join(", ");
  const colors = contrast.foreground && contrast.background ? `${contrast.foreground} on ${contrast.background}` : "";
  const extra = [colors, contrast.fontSize, contrast.fontWeight].filter(Boolean).join(", ");
  return extra ? `${ratio} (${extra})` : ratio;
}

/** axe's success-criterion tags (wcag143) as WCAG numbers (1.4.3). */
export function wcagCriteria(tags: readonly string[]): string[] {
  return tags.map((tag) => /^wcag(\d)(\d)(\d+)$/.exec(tag)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => `${m[1]}.${m[2]}.${m[3]}`);
}

export interface AccessibilityElement {
  ref?: string;
  selector: string;
  contrast?: string;
  issue?: string;
}

export interface AccessibilityRuleResult {
  rule: string;
  impact: string | null;
  help: string;
  wcag?: string[];
  count: number;
  elements: AccessibilityElement[];
  more?: number;
}

export interface AccessibilityAudit {
  tabId: string;
  url: string;
  kind: "accessibility";
  summary: string;
  engine: string;
  counts: Record<string, number>;
  violations: AccessibilityRuleResult[];
  review?: Array<{ rule: string; help: string; count: number }>;
  passedRules: number;
  path: string | null;
}

function selectorText(target: Array<string | string[]>): string | string[] {
  const last = target[target.length - 1];
  // Inside a shadow root axe names the element by its host chain.
  return Array.isArray(last) ? last : target.length > 1 ? target.map(String) : String(last ?? "");
}

/** The summary line an agent reads first. */
export function accessibilitySummary(run: Pick<AxeRun, "violations" | "incomplete" | "passes">): string {
  if (!run.violations.length) {
    const review = run.incomplete.length ? ` ${run.incomplete.length} rule${run.incomplete.length === 1 ? "" : "s"} need a manual check.` : "";
    return `No accessibility violations found by ${run.passes} rules.${review}`;
  }
  const elements = run.violations.reduce((sum, rule) => sum + rule.total, 0);
  const byImpact = IMPACT_ORDER.map((impact) => [impact, run.violations.filter((rule) => rule.impact === impact).length] as const)
    .filter(([, count]) => count > 0)
    .map(([impact, count]) => `${count} ${impact}`)
    .join(", ");
  const rules = [...run.violations]
    .sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || b.total - a.total)
    .slice(0, 6)
    .map((rule) => {
      const worst = rule.nodes.map((node) => node.contrast).filter((c): c is NonNullable<AxeNode["contrast"]> => Boolean(c)).sort((a, b) => a.ratio - b.ratio)[0];
      const detail = worst ? `, worst ${Math.floor(worst.ratio * 100) / 100}:1${worst.expected ? ` needs ${worst.expected}:1` : ""}` : "";
      return `${rule.id} x${rule.total} (${rule.impact ?? "unrated"}${detail})`;
    })
    .join(", ");
  const more = run.violations.length > 6 ? ` and ${run.violations.length - 6} more rules` : "";
  const review = run.incomplete.length ? ` ${run.incomplete.length} rule${run.incomplete.length === 1 ? "" : "s"} need a manual check.` : "";
  return `${run.violations.length} rule${run.violations.length === 1 ? "" : "s"} failed on ${elements} element${elements === 1 ? "" : "s"} (${byImpact}): ${rules}${more}.${review} ${run.passes} rules passed.`;
}

export async function auditAccessibility(target: BrowserTarget): Promise<AccessibilityAudit> {
  const run = await runAxe(target);
  const violations = [...run.violations].sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || b.total - a.total);
  const shown = violations.slice(0, RULES_SHOWN);
  const wanted = shown.flatMap((rule) => rule.nodes.slice(0, ELEMENTS_SHOWN_PER_RULE).map((node) => selectorText(node.target)));
  const refs = await refsForSelectors(target, wanted);
  let cursor = 0;
  const results: AccessibilityRuleResult[] = shown.map((rule) => {
    const elements = rule.nodes.slice(0, ELEMENTS_SHOWN_PER_RULE).map((node): AccessibilityElement => {
      const found = refs[cursor++];
      const fallback = selectorText(node.target);
      return {
        ...(found ? { ref: found.ref } : {}),
        selector: found?.selector ?? (Array.isArray(fallback) ? fallback.join(" >>> ") : fallback),
        ...(node.contrast ? { contrast: formatContrast(node.contrast) } : node.summary ? { issue: node.summary } : {}),
      };
    });
    // One issue text shared by every element says it once, on the rule.
    const issues = new Set(elements.map((element) => element.issue).filter(Boolean));
    if (issues.size === 1 && elements.length > 1) for (const element of elements) delete element.issue;
    return {
      rule: rule.id,
      impact: rule.impact,
      help: issues.size === 1 && elements.length > 1 ? `${rule.help}: ${[...issues][0]}` : rule.help,
      ...(wcagCriteria(rule.wcag).length ? { wcag: wcagCriteria(rule.wcag) } : {}),
      count: rule.total,
      elements,
      ...(rule.total > elements.length ? { more: rule.total - elements.length } : {}),
    };
  });
  const counts: Record<string, number> = {};
  for (const rule of violations) counts[rule.impact ?? "unrated"] = (counts[rule.impact ?? "unrated"] ?? 0) + rule.total;
  const info = await target.info().catch(() => null);
  const path = await writeBrowserArtifact(target.workspaceId, "audits", {
    label: "accessibility",
    ext: "json",
    data: JSON.stringify(run, null, 1),
  }).catch(() => null);
  return {
    tabId: target.ref,
    url: info?.url || run.url,
    kind: "accessibility",
    summary: accessibilitySummary(run) + (violations.length > RULES_SHOWN ? ` The first ${RULES_SHOWN} rules are listed; the file has all.` : ""),
    engine: run.engine,
    counts,
    violations: results,
    ...(run.incomplete.length ? { review: run.incomplete.slice(0, 8).map((rule) => ({ rule: rule.id, help: rule.help, count: rule.total })) } : {}),
    passedRules: run.passes,
    path,
  };
}
