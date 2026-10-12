export const meta = {
  name: "understand",
  description: "Map an unfamiliar codebase area: parallel readers per question, then one synthesis",
  whenToUse: "When you need a reliable picture of how something works before changing it",
  args: {
    type: "object",
    properties: {
      topic: { type: "string", description: "What to understand, for example 'how login sessions are refreshed'" },
    },
    required: ["topic"],
  },
  phases: [
    { title: "Read", detail: "one reader per question" },
    { title: "Synthesize", detail: "one writer" },
  ],
  caps: { maxAgents: 10, concurrency: 4 },
};

const topic = (args && args.topic) || "the main flow of this project";
const QUESTIONS = [
  `Where does ${topic} start and end in the code? Name the entry points and files.`,
  `What data and state does ${topic} read and write, and where is it stored?`,
  `What can go wrong in ${topic}: error paths, retries, edge cases, and how they are handled?`,
  `Which tests cover ${topic}, and what do they leave untested?`,
];

phase("Read");
const notes = await parallel(QUESTIONS.map((question, index) => () =>
  agent(`${question}\n\nAnswer from the code with file paths. Say what you could not find.`, {
    label: `read ${index + 1}`,
    access: "readonly",
    agentType: "researcher",
  })));

phase("Synthesize");
return await agent(
  `Write a concise, accurate explanation of ${topic} for an engineer about to change it, ` +
    "from these notes by readers who studied the code. Resolve contradictions by checking the code yourself.\n\n" +
    notes.map((note, index) => `## Notes ${index + 1}\n${note || "(this reader found nothing)"}`).join("\n\n"),
  { label: "synthesis", access: "readonly" },
);
