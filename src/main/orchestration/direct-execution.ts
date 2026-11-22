import type { ChatMode, CoraExecutionStrategy } from "@shared/types";
import { userCommandOf } from "../../shared/user-commands";

const MANAGED_REQUEST =
  /\b(?:all (?:failures|lint errors|tests|type errors|typecheck errors)|architecture|architectural|audit (?:the )?(?:entire|whole)|background task|deep research|everything|investigate (?:the )?(?:entire|whole)|long[- ]running|migration|multi[- ]agent|parallel(?:ize|ise| work| agents?)|plan mode|refactor (?:the )?(?:app|application|codebase|project|repository)|repository[- ]wide|research the web|search the web|whole (?:app|application|codebase|project|repository)|work across (?:the )?(?:app|codebase|project|repository))\b/i;

// The direct lane's worker cannot write the whiteboard or board, author
// automations, or ask a blocking question (worker-policy.ts keeps those
// surfaces read-only for every worker), so requests for them go to the
// manager, which has those tools.
const STUDIO_SURFACE_REQUEST =
  /\b(?:whiteboard|kanban|board|automations?|loom|schedul(?:e|ed|ing)|cron(?:tab|job)?|recurring|nightly|hourly|every (?:day|night|hour|morning|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s*(?:min(?:ute)?s?|hours?|days?)))\b/i;

// The direct lane is one worker on one model that cannot start helpers, so a
// request that hands parts of the work to other agents or to several named
// models needs the manager. Two models count when both are handed work: two
// "use/have/let <model> <work>" assignments, or one plus "and <model> <work>"
// ("use astra for the hard task and sol for the rest", "have opus write the
// parser and sonnet write the tests"). One model, or models merely mentioned
// ("codex on linux and claude on mac both crash", "sonnet writes bad code,
// claude does better: use claude for this"), does not.
const WORKER_MODEL_NAME =
  "(?:opus|sonnet|haiku|fable|astra|sol|terra|luna|grok|gemini|codex|claude|gpt[-\\w.]*)";
const MODEL_WORK = "(?:for|on|to (?:do|handle|take)|write|writes|build|builds|do|does|handle|handles|take|takes|review|reviews|implement|implements|fix|fixes)";
const MODEL_ASSIGNED = new RegExp(`\\b(?:use|have|let)\\s+(${WORKER_MODEL_NAME})\\s+${MODEL_WORK}\\b`, "gi");
const MODEL_ALSO_ASSIGNED = new RegExp(`\\band\\s+(${WORKER_MODEL_NAME})\\s+${MODEL_WORK}\\b`, "gi");
const AGENT_COUNT = "(?:two|three|four|five|\\d+|multiple|several|separate|parallel|some|a few)";
const DELEGATION_REQUEST = new RegExp(
  [
    // spawn / spin up / launch sub-agents or N agents
    `\\b(?:spawn|spin up|launch|start|dispatch)\\s+(?:(?:a|an|one|the|${AGENT_COUNT}|helper)\\s+){0,2}(?:sub[- ]?agents?|helper agents?|agents in parallel|workers in parallel)\\b`,
    `\\b(?:spawn|spin up|launch|start|dispatch)\\s+${AGENT_COUNT}\\s+(?:agents|workers)\\b`,
    // use (N) sub-agents (never "use the sub-agent API")
    `\\buse\\s+${AGENT_COUNT}\\s+(?:sub[- ]?agents|helper agents|agents)\\b`,
    `\\buse\\s+(?:sub[- ]?agents|helper agents)\\b`,
    // delegate / hand off / split the work
    `\\b(?:delegate(?: (?:it|this|them|the work|tasks?))? to|hand (?:it|this|them|the work) (?:off )?to|split (?:it|this|the work) (?:across|between|among))\\s+(?:(?:a|an|the|${AGENT_COUNT}|helper)\\s+){0,2}(?:sub[- ]?agents?|helper agents?|agents|workers|models)\\b`,
    `\\b(?:a )?different models? (?:for|per) (?:each|every|the) (?:task|part|step|piece)s?\\b`,
  ].join("|"),
  "i",
);

// A worker cannot stop and wait for the user, so a request to see several
// options first, or to hold the build until the user picks or approves,
// needs the manager's question tool. Options count only with a number or
// "some"/"a few" before them, or a gate after ("before", "first", "to choose",
// "I'll pick"); "show me the options in the config file" is a read.
const CHOICE_NOUN = "(?:options|choices|alternatives|approaches|variants|versions|mock-?ups|designs|directions|layouts|drafts|takes)";
const APPROVAL_GATE_REQUEST = new RegExp(
  [
    // "build two layouts: mobile and desktop" is work, not a choice
    `\\b(?:show|give|present|offer|propose)\\s+(?:me\\s+)?(?:\\d+|two|three|four|five|some|a few|several|multiple|a couple of)\\s+(?:\\w+\\s+){0,2}?${CHOICE_NOUN}\\b`,
    `\\b(?:show|give|present|offer|propose)\\s+me\\s+(?:the\\s+|your\\s+)?(?:\\w+\\s+){0,2}?${CHOICE_NOUN}\\b[^.?!]{0,80}?\\b(?:before|first|to (?:choose|pick|decide)|and I(?:'ll| will)? (?:pick|choose|decide))\\b`,
    `\\b${CHOICE_NOUN}\\s+(?:for me\\s+)?to\\s+(?:choose|pick|decide)\\b`,
    // the user picks: "and I decide which one", "I'll pick one"
    `(?:\\band|\\bthen|,)\\s+I(?:'ll| will)?\\s+(?:decide|choose|pick)\\s+(?:which|one|between|from|the best)\\b`,
    `\\bI(?:'ll| will)\\s+(?:pick|choose)\\s+(?:one|which|the best|between)\\b`,
    // the build waits on the user
    `\\bonly\\b[^.?!]{0,80}?\\b(?:once|after|when)\\s+I\\s+(?:approve|confirm|decide|choose|pick|sign off|say go|give the go)\\b`,
    `\\b(?:don't|do not|never)\\b[^.?!]{0,80}?\\buntil\\s+I\\s+(?:approve|confirm|decide|choose|pick|sign off|say)\\b`,
    `\\b(?:once|after|when)\\s+I\\s+(?:approve|sign off|say go|give the go)\\b[^.?!]{0,40}?\\b(?:you|then)\\s+(?:can\\s+)?(?:build|implement|start|apply|proceed|go ahead)\\b`,
    `\\b(?:wait for|get|ask for)\\s+my\\s+(?:approval|go[- ]ahead|ok|okay|sign[- ]off|decision|choice)\\b`,
    `\\bwait for me\\b`,
    `\\bbefore (?:you )?(?:build|start|implement|change|touch|writ)(?:e|ing)?\\s+anything\\b`,
  ].join("|"),
  "i",
);

/** Work the direct worker cannot do: delegate to other agents or models, or wait for the user's pick. */
function needsManagerFeatures(text: string): boolean {
  if (DELEGATION_REQUEST.test(text) || APPROVAL_GATE_REQUEST.test(text)) return true;
  const assigned = [...text.matchAll(MODEL_ASSIGNED)].map((match) => match[1].toLowerCase());
  if (assigned.length === 0) return false;
  const also = [...text.matchAll(MODEL_ALSO_ASSIGNED)].map((match) => match[1].toLowerCase());
  return new Set([...assigned, ...also]).size >= 2;
}

// A slash command naming a loaded skill (`/ceo`, `/skill:verify`) runs it, and
// only the manager's Pi session expands skills the user invokes. The same
// first-line rule as the manager's header (user-commands.ts), so a message
// that starts with a path such as `/home/...` stays on the direct lane.
export function runsSkill(text: string, skillNames: ReadonlySet<string> | undefined): boolean {
  const command = userCommandOf(text);
  return Boolean(command && skillNames?.has(command.name));
}

const SOCIAL_REQUEST = /^(?:(?:hi|hello|hey|yo|sup|what(?:'s| is) up|good (?:morning|afternoon|evening)|how are you)(?:\s+(?:cora|there))?[!?.\s]*|(?:thanks|thank you|sounds good|okay|ok|cool|nice|great)[!?.\s]*|what(?:'s| is) your (?:favorite|favourite)\b[^\n]{0,120}|who are you[!?.\s]*|tell me (?:a|another) joke[!?.\s]*)$/i;

/**
 * A follow-up in a finished direct chat that the direct worker cannot serve:
 * broad or parallel work, or a Studio surface it has no write tools for. The
 * chat then continues with the manager instead of another direct pass.
 */
export function followUpNeedsManager(prompt: string, skillNames?: ReadonlySet<string>): boolean {
  const text = prompt.trim();
  return (
    text.length > 4_000 ||
    runsSkill(text, skillNames) ||
    MANAGED_REQUEST.test(text) ||
    STUDIO_SURFACE_REQUEST.test(text) ||
    needsManagerFeatures(text)
  );
}

export function isConversationalRequest(prompt: string): boolean {
  return SOCIAL_REQUEST.test(prompt.trim());
}

export interface DirectExecutionDecisionInput {
  strategy?: CoraExecutionStrategy;
  cwd: string;
  prompt?: string;
  chatMode?: ChatMode;
  hasPlan?: boolean;
  hasAttachments?: boolean;
  hasFanOut?: boolean;
  hasCouncil?: boolean;
  /** Skills Cora's Pi loads here (listCodaraPiSkillNames). */
  skillNames?: ReadonlySet<string>;
}

/**
 * Pick Cora's direct lane before spending a manager turn.
 *
 * Explicit choices always win. Auto stays deliberately conservative: a short
 * bounded request goes straight to one capable tool-using model; broad,
 * parallel, research, and plan-shaped work keeps Cora's orchestrator. Repo
 * size is deliberately irrelevant: scanning a large tree adds latency, and a
 * one-file fix is still bounded when the repository happens to be large.
 */
export async function shouldUseDirectExecution(
  input: DirectExecutionDecisionInput,
): Promise<boolean> {
  if (input.strategy === "managed") return false;
  if (
    !input.prompt?.trim() ||
    input.chatMode === "talk" ||
    input.chatMode === "plan" ||
    input.chatMode === "automation" ||
    input.hasPlan ||
    input.hasAttachments ||
    input.hasFanOut ||
    input.hasCouncil
  ) {
    return false;
  }
  if (input.strategy === "direct") return true;

  const prompt = input.prompt.trim();
  if (isConversationalRequest(prompt)) return false;
  if (prompt.length > 4_000 || runsSkill(prompt, input.skillNames) || MANAGED_REQUEST.test(prompt)) return false;
  if (STUDIO_SURFACE_REQUEST.test(prompt)) return false;
  if (needsManagerFeatures(prompt)) return false;
  return true;
}
