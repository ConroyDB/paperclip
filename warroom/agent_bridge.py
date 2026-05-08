"""
ClaudeAgentBridge: a Pipecat FrameProcessor that takes routed messages,
calls the appropriate Hermes Cloud Run agent over HTTP, and emits
TTS-ready text frames with the correct agent voice.

The bridge POSTs to each agent's synchronous task endpoint:
    https://<service>-794842605643.us-central1.run.app/discord
with JSON body {"message": "...", "user": "warroom"} and reads the
"response" field. This is the same endpoint the Discord gateway uses,
so the agent returns its full response text after running through SOUL
+ 200 MCP tools + Paperclip wiring.

This replaces the prior local Node.js subprocess bridge which talked to
ClaudeClaw council shims (no SOUL, no MCP, no Paperclip wiring).
"""

import asyncio
import logging
from typing import Optional

import httpx

from pipecat.frames.frames import TextFrame, TTSUpdateSettingsFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

from config import AGENT_VOICES, DEFAULT_AGENT
from router import AgentRouteFrame, AGENT_NAMES


logger = logging.getLogger("warroom.agent_bridge")

# How long to wait for the Cloud Run agent to respond (seconds). Cold-start
# from scale-to-zero takes ~15-30s; warm requests answer in 2-10s. KB-search
# tasks can run to ~60s on a warm container.
BRIDGE_TIMEOUT = 120

# SSD swarm via cbi-swarm.ngrok.app router (Sovereign_OS Mac Mini, all 15
# personalities live behind one tunnel — see scripts/swarm_router.py).
# {agent} is the Hermes service name (e.g. "yano-langley") OR the short
# profile name ("yano"); the router resolves both via SERVICE_ALIASES.
# /discord returns {"response": "...", "agent": "..."} — same shape as the
# old Cloud Run /discord, so callers needed no changes.
AGENT_URL_TEMPLATE = "https://cbi-swarm.ngrok.app/{agent}/discord"

# Identifies the caller in MC/Discord chat logs so War Room invocations are
# distinguishable from real Discord traffic.
WARROOM_USER_TAG = "warroom-voice"

# Agent order for round-robin broadcasts. Hermes Cloud Run service names.
BROADCAST_ORDER = [
    "yano-langley",             # COO routing
    "alessandra-moretti-reyes", # narrative
    "kairo-vega",               # revenue
    "gia-costa-moretti",        # reactivation
    "ava-kim",                  # content
]


class ClaudeAgentBridge(FrameProcessor):
    """Receives AgentRouteFrames, calls the Hermes Cloud Run agent, and emits
    voice-switched TextFrames for TTS output."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._current_voice: Optional[str] = None

    async def process_frame(self, frame, direction: FrameDirection):
        # CRITICAL: Must call super first so the parent registers StartFrame
        await super().process_frame(frame, direction)

        # Only handle AgentRouteFrames going downstream
        if not isinstance(frame, AgentRouteFrame):
            await self.push_frame(frame, direction)
            return

        if frame.mode == "broadcast":
            await self._handle_broadcast(frame.message)
        else:
            await self._handle_single(frame.agent_id, frame.message)

    async def _handle_single(self, agent_id: str, message: str):
        """Route a message to one agent and emit its response."""
        if agent_id not in AGENT_NAMES:
            agent_id = DEFAULT_AGENT

        response = await self._call_agent(agent_id, message)
        if response:
            await self._emit_response(agent_id, response)

    async def _handle_broadcast(self, message: str):
        """Send the message to each agent in order and emit all responses."""
        for agent_id in BROADCAST_ORDER:
            response = await self._call_agent(agent_id, message)
            if response:
                # Prefix with agent name so the listener knows who is speaking.
                # Use the entry's display name if available, else the service id.
                display = (AGENT_VOICES.get(agent_id) or {}).get("name") or agent_id
                tagged = f"{display.split('—')[0].strip()} here. {response}"
                await self._emit_response(agent_id, tagged)

    async def _emit_response(self, agent_id: str, text: str):
        """Switch TTS voice to the agent's voice, then emit the text."""
        # Guard against voices.json being hand-edited into a shape where
        # AGENT_VOICES.get(DEFAULT_AGENT) is None, or where the matched
        # entry is a dict missing `voice_id` (legit in live mode which
        # only tracks `gemini_voice`). Either case would raise TypeError
        # or KeyError mid-response and crash the bridge silently.
        voice_config = AGENT_VOICES.get(agent_id) or AGENT_VOICES.get(DEFAULT_AGENT) or {}
        voice_id = voice_config.get("voice_id", "")

        # Only send a voice-switch frame if we have a voice AND it actually changed
        if voice_id and voice_id != self._current_voice:
            await self.push_frame(TTSUpdateSettingsFrame(
                settings={"voice": voice_id}
            ))
            self._current_voice = voice_id

        await self.push_frame(TextFrame(text=text))

    async def _call_agent(self, agent_id: str, message: str) -> Optional[str]:
        """POST the message to the Hermes Cloud Run agent's /task endpoint.

        Returns the agent's text response, or None on failure.
        """
        url = AGENT_URL_TEMPLATE.format(agent=agent_id)
        logger.info(
            "calling agent %s at %s (msg preview: %r)",
            agent_id, url, message[:80],
        )

        try:
            async with httpx.AsyncClient(timeout=BRIDGE_TIMEOUT) as client:
                r = await client.post(
                    url,
                    json={"message": message, "user": WARROOM_USER_TAG},
                )
                r.raise_for_status()
                data = r.json()

            if not isinstance(data, dict):
                logger.warning("Agent %s returned non-dict body: %r", agent_id, data)
                return str(data) if data else None

            if data.get("error"):
                logger.error("Agent %s returned error: %s", agent_id, data["error"])
                return f"The {agent_id} agent ran into an issue."

            text = (
                data.get("response")
                or data.get("final_response")
                or data.get("result")
                or data.get("text")
            )
            if text:
                return text

            logger.warning("Agent %s returned empty response: %s", agent_id, data)
            return None

        except httpx.TimeoutException:
            logger.error("Agent %s timed out after %ds", agent_id, BRIDGE_TIMEOUT)
            return f"The {agent_id} agent took too long to respond."

        except httpx.HTTPStatusError as exc:
            logger.error(
                "Agent %s returned HTTP %d: %s",
                agent_id, exc.response.status_code, exc.response.text[:200],
            )
            return f"The {agent_id} agent ran into an issue. Try again in a moment."

        except Exception as exc:
            logger.error("Failed to call agent %s: %s", agent_id, exc, exc_info=True)
            return f"Something went wrong reaching the {agent_id} agent."
