# src/agent

The agent loop and everything it calls each step: `agentLoop.ts` (the loop), prompt building (`systemPrompt.ts`, `promptPrefix.ts`, `contextManager.ts`), tool-call parsing (`toolProtocol.ts`), the checks and nudges on a final answer (`claimChecker.ts`, `requirements.ts`, `verifyBeforeDone.ts`, `loopDetector.ts`), approvals, checkpoints and trace logging. Behavior reference: `../../docs/HARNESS_REFERENCE.md`.
