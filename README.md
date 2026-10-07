# Program Risk Copilot

An AI agent on Cloudflare that reads program and change status updates, scores delivery risk, and keeps a persistent risk register. It flags risk for a human to decide on; it never makes a go/no-go call itself.

**Live demo:** https://orange-grass-8b45.karthikeyan-arun9.workers.dev

Built from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template. The agent logic, tools and reliability safeguards are in [`src/server.ts`](src/server.ts).

## What it does

Paste a status update into the chat, for example:

> Checkout team: the change was reviewed 30 minutes before deploy, regression testing was skipped, and it's going out right before the holiday freeze.

The agent identifies risk signals, assigns a level (LOW, MEDIUM, HIGH or NEEDS_HUMAN_REVIEW), explains why, recommends an action, and logs it to the register. You can then ask what's open, escalate a risk to leadership, or schedule a digest.

## How it meets the assignment requirements

| Requirement | Implementation |
| --- | --- |
| LLM | Kimi K2.7 on Workers AI (`@cf/moonshotai/kimi-k2.7-code`) via the Vercel AI SDK |
| Workflow / coordination | Durable Object agent (`AIChatAgent`) orchestrating six tools; escalating and clearing require human approval |
| User input via chat | Chat UI connected to the agent over WebSockets |
| Memory / state | Risk register stored in the agent's persistent state |

## Risk scoring

Six signals: short review window, incomplete testing, repeat incidents, risky timing, rushed language, missing rollback plan.

- **LOW:** no meaningful signals
- **MEDIUM:** one moderate signal, or two minor ones
- **HIGH:** any single severe signal (such as skipped testing), or three or more signals
- **NEEDS_HUMAN_REVIEW:** the model is not confident

## Reliability safeguards

Testing surfaced several problems; each is handled in code so the app doesn't depend on the model behaving perfectly:

- **Doubled streaming:** the Workers AI connector passes every streamed piece through twice, which breaks tool-call JSON. A stream filter removes the duplicates and rebuilds tool arguments; a repair step re-asks the model if they're still unreadable.
- **Duplicate logging:** the same team with the same signals within 10 minutes isn't logged again.
- **Inconsistent signal names:** loose phrasing is mapped onto the six standard names.
- **Logging on commands:** the log tool only writes when the latest message is a status update, not a command or question.
- **Silent turns:** if the model ends a turn with only a tool call, the app writes a short reply from the tool results.
- **Human approval enforced in code:** escalation and clearing always show an Approve/Reject prompt, whatever the model says.

The project started on Llama 3.3. It repeatedly re-ran earlier tool calls and ignored "don't retry" results, so it was switched to Kimi K2.7, the model Cloudflare's current starter template uses.

## Run it locally

Requires Node.js and a free Cloudflare account.

```bash
npm install
npx wrangler login
npm run dev
```

Deploy with `npm run deploy`.

## Limitations

- Escalation is simulated: it marks the risk and notifies the chat. A production version would post to Slack or email.
- No authentication: anyone with the link shares one register.
- The digest runs once after a delay; a weekly digest would use the scheduler's cron support.
- The risk level is the model's judgment against the rubric; measuring accuracy would need a labeled set of past updates.
