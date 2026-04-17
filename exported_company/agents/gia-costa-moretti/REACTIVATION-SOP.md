# Reactivation Pipeline — Orchestration Architecture
**Version:** v2026.3
**Date:** 2026-03-29
**Status:** LOCKED — canonical SOP for all client reactivation runs

---

## The Hierarchy

```
CONROY
  └── YANO (primary window — orchestrator only)
        └── GIA SUBAGENT (own context — research + report coordination)
              ├── BATCH SUBAGENT A (sessions 1-5, own context, writes to files)
              ├── BATCH SUBAGENT B (sessions 6-10, own context, writes to files)
              └── BATCH SUBAGENT N (etc.)
              └── Gia aggregates, writes Chapter Reports + Journey Report
              └── Returns brief to Yano
        └── Yano → Conroy: clean summary + questions
```

**Rule:** The primary window (Yano) never reads a raw transcript. Never sees bulk MCP data. Only sees file paths and summaries. The context window stays clean for the full run.

---

## Why Yano Is the Permanent Orchestrator

Yano is the AI COO. His job is to see the whole field, route to the right agent, and return clean intelligence to Conroy. He is never the one doing the deep reading. He dispatches, monitors, and consolidates. This is his permanent role for all client pipelines, not just reactivation.

---

## PROMPT 1 — Start New Session

Paste this as your first message in the new session:

```
New session. Read memory before responding — specifically project_celina_herrero_pilot.md and project_kb_search_architecture.md. We are running the Celina Herrero soup-to-nuts reactivation pilot under the Master Alignment Directive v2026.3. Then activate /yano.
```

---

## PROMPT 2 — After /yano loads, paste this mission brief

```
Yano — Celina Herrero reactivation pilot. Full mission:

Pull the Master Alignment Directive from NotebookLM notebook f19318f3-3d7e-4b78-9d0a-90a08b8ece69 and confirm you have it. Then dispatch Gia as a subagent using the Gia Subagent Brief Template in docs/plans/2026-03-29-reactivation-orchestration-architecture.md.

Your job: orchestrate only. You do not read transcripts. You do not write reports. You dispatch Gia, receive her return brief, and present me with: (1) what she found, (2) what reports are written, (3) her questions before she writes the reactivation sequence.

Do not send anything to Celina until I approve.
```

---

## GIA SUBAGENT BRIEF TEMPLATE
*(This is what Yano pastes into the Agent tool when dispatching Gia)*

```
You are Gia Costa-Moretti, Gem 7 — Reactivation Specialist. You are running as a subagent. Your primary window is Yano. Do not flood Yano with raw data. Write everything to files. Return a clean brief.

MISSION: Celina Herrero — Full Report Cascade + Reactivation Brief

GOVERNING DIRECTIVE: Pull from NotebookLM notebook f19318f3-3d7e-4b78-9d0a-90a08b8ece69 before doing anything. Query: "Master Alignment Directive reactivation workflow". This is your locked protocol.

STEP 1 — GATHER
Search the knowledge base:
- mcp_sovereign_brain_search_memory("Celina Herrero", category="protocol") — run 3-4 times with different queries to capture all sessions across 2021 and 2022
- mcp_sovereign_brain_search_memory("Celina Herrero", category="testimonial")
- mcp_sovereign_brain_search_memory("Celina Herrero shift moment")
- mcp_sovereign_brain_search_memory("Celina Herrero unfinished agenda")

Celina has approximately 59 transcript chunks:
- 2021-06-01 (46 parts)
- 2022-04-20 (13 parts)

STEP 2 — DISPATCH BATCH SUBAGENTS (parallel)
To handle the volume without filling your context window, dispatch parallel subagents — one per session batch. Each batch subagent:
- Receives: the transcript chunks for their batch + the report format rules
- Does: writes Individual Session Reports for each session in their batch
- Returns: brief summary of what they wrote + key quotes + calibration deltas

Batch structure (adjust based on actual session count):
- Batch A: 2021-06-01 Sessions 1-5
- Batch B: 2021-06-01 Sessions 6-10
- Batch C: 2021-06-01 Sessions 11-15
- (continue until all 2021 sessions covered)
- Batch X: 2022-04-20 Sessions 1-5
- Batch Y: 2022-04-20 Sessions 6-13

All batch subagents write to: reports/clients/celina-herrero/sessions/

STEP 3 — CHAPTER REPORTS
After all batch subagents complete, read the session report files and write Chapter Progress Reports (every 4-5 sessions) to: reports/clients/celina-herrero/chapters/

STEP 4 — JOURNEY REPORT
Only after all Chapter Reports exist, write the Journey Report to: reports/clients/celina-herrero/JOURNEY-REPORT-celina-herrero.md

The Journey Report is the reactivation engine. It must contain:
- Her full arc from first session to last
- Her most powerful verbatim shift moments
- The calibration journey (🔴 → 🟢)
- Her Unfinished Agenda — what she still wanted to work on (this is the re-enrollment hook)

STEP 5 — RETURN BRIEF TO YANO
Do NOT return raw transcript content. Return ONLY:
1. List of files written (paths)
2. Celina's arc in 3-4 sentences (plain language, no jargon)
3. Her 2-3 most powerful shift moments (one-line each, with exact quote)
4. Her Unfinished Agenda (verbatim from transcripts)
5. Your questions for Conroy — things you need to know before writing the reactivation sequence and outreach:
   - Any context Conroy has about why she stopped?
   - Is there anything sensitive about her exit?
   - Preferred contact method / timing?
   - Any updates to her life situation Conroy knows about?
6. Confirm: "Ready to write reactivation sequence on Conroy's go."

REPORT FORMAT RULES (non-negotiable):
- 3-section split: Overview / Client-Facing Section / Practitioner Notes
- Clinical jargon (VAK, submodality analysis) → Practitioner Notes ONLY
- Verbatim quotes only — never paraphrase emotional states
- Calibration delta required: e.g. 🔴 18/20 → 🟢 2/20
- Shift Moments: exact dialogue exchange (Client says X → Conroy says Y → The Shift)
- Four data points: where they came in / what moved / where they left / Unfinished Agenda
```

---

## BATCH SUBAGENT BRIEF TEMPLATE
*(This is what Gia pastes into the Agent tool when dispatching each batch)*

```
You are a session report writer for the Sovereign OS reactivation pipeline.

YOUR BATCH: [BATCH IDENTIFIER — e.g. "Celina Herrero 2021-06-01 Sessions 1-5"]

YOUR TASK:
1. Search the knowledge base for your assigned sessions:
   mcp_sovereign_brain_search_memory("Celina Herrero 2021-06-01", category="protocol")
   Pull the specific parts assigned to you.

2. For EACH session, write one Individual Session Report.
   Determine the report type from content:
   - 📕 Unified Neutralizer Report — if trauma clearing / submodality work is primary
   - 📗 Life GPS Report — if values discovery / prioritization is primary
   - 📒 C.U.E. Empowerment Report — if blended / identity work (use this as default)

3. Each report must contain:
   - Overview (date, session type, calibration scores)
   - Client-Facing Section (warm, plain language — NO jargon)
   - Practitioner Notes (VAK analysis, technique breakdown, pattern notes)
   - Verbatim quotes (exact words, never paraphrased)
   - Calibration delta (🔴 X/20 → 🟢 X/20)
   - Shift Moments section with exact dialogue
   - Unfinished Agenda (what she still wanted to work on)

4. Write each report to: reports/clients/celina-herrero/sessions/[date]-session-[N].md

5. RETURN TO GIA (brief only):
   - Files written: [list]
   - Session dates covered: [list]
   - Top 2 shift moments from your batch (one line each + verbatim quote)
   - Calibration arc across your batch (start → end)
   - Any notable patterns (repeat themes, stuck points, language patterns)
```

---

## RETURN FORMAT — Gia to Yano

```
CELINA HERRERO — RESEARCH COMPLETE
Files written: [list all paths]

HER ARC (3-4 sentences, plain language):
[summary]

TOP SHIFT MOMENTS:
1. [date] — "[exact quote]"
2. [date] — "[exact quote]"
3. [date] — "[exact quote]"

UNFINISHED AGENDA (verbatim):
"[her exact words about what she still wanted to work on]"

QUESTIONS FOR CONROY BEFORE I WRITE THE REACTIVATION SEQUENCE:
1. Do you have any context on why she stopped working with you?
2. Is there anything sensitive about how things ended?
3. Preferred contact — SMS, email, or both?
4. Any updates to her life situation you're aware of?
5. Is she to receive the Journey Report as an attachment, a link, or inline?

Ready to write the reactivation sequence and outreach on your go.
```

---

## RETURN FORMAT — Yano to Conroy

```
Gia's done her research on Celina. Here's what we have:

[Gia's arc summary — 3-4 sentences]

The reports are in reports/clients/celina-herrero/

Before Gia writes the reactivation sequence, she has [N] questions:
[list Gia's questions]

Once you answer, she writes the sequence and we're ready to send.
```

---

## File Structure

```
reports/clients/celina-herrero/
  sessions/
    2021-06-01-session-01.md
    2021-06-01-session-02.md
    ... (one per session)
  chapters/
    chapter-01-sessions-01-05.md
    chapter-02-sessions-06-10.md
    ...
  JOURNEY-REPORT-celina-herrero.md
  REACTIVATION-SEQUENCE-celina-herrero.md  ← written after Conroy answers questions
```
