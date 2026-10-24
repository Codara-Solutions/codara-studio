export const meta = {
  name: "design-panel",
  description: "Get independent designs for one problem, have a panel score them, and return the best",
  whenToUse: "Before committing to an approach for a change with several reasonable designs",
  args: {
    type: "object",
    properties: {
      problem: { type: "string", description: "The problem to design a solution for" },
      designs: { type: "integer", minimum: 2, maximum: 5, description: "How many designs (default 3)" },
    },
    required: ["problem"],
  },
  phases: [
    { title: "Design", detail: "independent designers" },
    { title: "Judge", detail: "one judge per design" },
  ],
  caps: { maxAgents: 12, concurrency: 4 },
};

const problem = (args && args.problem) || "the most important open design question in this repository";
const count = Math.max(2, Math.min(5, (args && args.designs) || 3));
const ANGLES = ["the simplest thing that works", "the most robust under failure", "the easiest to extend later", "the fastest at runtime", "the least code changed"];

const SCORE = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10 },
    strengths: { type: "string" },
    risks: { type: "string" },
  },
  required: ["score", "strengths", "risks"],
};

phase("Design");
const designs = await parallel(ANGLES.slice(0, count).map((angle, index) => () =>
  agent(
    `Design a solution to this problem, optimizing for ${angle}:\n\n${problem}\n\n` +
      "Read the relevant code first. Describe the design concretely: files, data flow, and the order of changes. Do not implement it.",
    { label: `design ${index + 1}: ${angle}`, access: "readonly" },
  )));

phase("Judge");
const scores = await parallel(designs.map((design, index) => () =>
  design === null
    ? null
    : agent(
        `Judge this design for the problem below against the actual code. Score it 1 to 10.\n\nProblem:\n${problem}\n\nDesign:\n${design}`,
        { label: `judge ${index + 1}`, schema: SCORE, agentType: "verifier" },
      )));

let best = -1;
for (let index = 0; index < designs.length; index += 1) {
  if (!scores[index]) continue;
  if (best < 0 || scores[index].score > scores[best].score) best = index;
}
if (best < 0) return { winner: null, reason: "no design could be scored" };
return { winner: designs[best], score: scores[best], ranking: scores.map((s, i) => ({ design: i + 1, score: s ? s.score : null })) };
