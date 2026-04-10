import json
import os
import hashlib
import time
import requests
from src.agent.capability import MatchingCapability
from src.main import AgentWorker
from src.agent.capability_worker import CapabilityWorker

# =============================================================================
# ORYNQ AI AUDITABILITY
# Creates tamper-proof, blockchain-anchored audit trails for AI conversations
# using Orynq's Proof-of-Inference (PoI) protocol.
#
# Pattern: Speak -> Collect context -> Build cryptographic trace -> Anchor to
#          Cardano blockchain -> Speak verification hash -> Exit
#
# Requires: An Orynq API key from https://fluxpointstudios.com
# =============================================================================

# --- CONFIGURATION ---
ORYNQ_API_URL = "https://api-v3.fluxpointstudios.com"
ORYNQ_API_KEY = "YOUR_ORYNQ_API_KEY_HERE"


class OrynqAiAuditabilityCapability(MatchingCapability):
    worker: AgentWorker = None
    capability_worker: CapabilityWorker = None

    @classmethod
    def register_capability(cls) -> "MatchingCapability":
        with open(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        ) as file:
            data = json.load(file)
            return cls(
                unique_name=data["unique_name"],
                matching_hotwords=data["matching_hotwords"],
            )

    def call(self, worker: AgentWorker):
        self.worker = worker
        self.capability_worker = CapabilityWorker(self.worker)
        self.worker.session_tasks.create(self.run())

    def _build_trace_event(self, kind, content, visibility="public"):
        """Build a single trace event with a SHA-256 content hash."""
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        event = {
            "kind": kind,
            "content": content,
            "visibility": visibility,
            "timestamp": timestamp,
        }
        event_bytes = json.dumps(event, sort_keys=True).encode("utf-8")
        event["hash"] = hashlib.sha256(event_bytes).hexdigest()
        return event

    def _build_trace(self, agent_id, description, events):
        """
        Build a process trace bundle with a rolling SHA-256 hash chain.

        Each event hash is chained with the previous to create an immutable
        ordering proof. The final rootHash proves the exact sequence of events
        without revealing their contents.
        """
        chain_hash = hashlib.sha256(b"orynq:trace:init").hexdigest()
        hashed_events = []

        for event in events:
            event_hash = event["hash"]
            chain_input = f"{chain_hash}:{event_hash}".encode("utf-8")
            chain_hash = hashlib.sha256(chain_input).hexdigest()
            hashed_events.append(event)

        manifest = {
            "schema": "poi-anchor-v1",
            "type": "process-trace",
            "version": "1.0",
            "agentId": agent_id,
            "description": description,
            "rootHash": f"sha256:{chain_hash}",
            "itemCount": len(events),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "events": hashed_events,
        }

        manifest_bytes = json.dumps(manifest, sort_keys=True).encode("utf-8")
        manifest["manifestHash"] = (
            f"sha256:{hashlib.sha256(manifest_bytes).hexdigest()}"
        )
        return manifest

    async def _submit_to_orynq(self, manifest):
        """Submit the trace manifest to Orynq for Cardano blockchain anchoring."""
        try:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {ORYNQ_API_KEY}",
            }
            response = requests.post(
                f"{ORYNQ_API_URL}/anchors/process-trace",
                headers=headers,
                json={"manifest": manifest},
                timeout=30,
            )

            if response.status_code in (200, 201):
                return response.json()
            else:
                self.worker.editor_logging_handler.error(
                    f"[OrynqAudit] API returned {response.status_code}: "
                    f"{response.text}"
                )
                return None

        except Exception as e:
            self.worker.editor_logging_handler.error(
                f"[OrynqAudit] Error submitting to Orynq: {e}"
            )
            return None

    async def run(self):
        try:
            # Step 1: Explain what we're doing and ask for context
            await self.capability_worker.speak(
                "I'll create a tamper-proof audit trail for this conversation "
                "using Orynq. What would you like to include in the audit record?"
            )

            # Step 2: Get user input
            user_input = await self.capability_worker.user_response()

            if not user_input or user_input.strip().lower() in (
                "stop",
                "exit",
                "cancel",
                "nevermind",
                "never mind",
            ):
                await self.capability_worker.speak(
                    "No problem, audit cancelled."
                )
                self.capability_worker.resume_normal_flow()
                return

            # Step 3: Acknowledge and build trace
            await self.capability_worker.speak(
                "Building your cryptographic audit trail and anchoring it to "
                "the Cardano blockchain now."
            )

            events = [
                self._build_trace_event(
                    "observation", "Audit requested by user via voice"
                ),
                self._build_trace_event(
                    "command", f"User context: {user_input}"
                ),
                self._build_trace_event(
                    "decision",
                    "Creating blockchain-anchored audit record via Orynq "
                    "Proof-of-Inference protocol",
                ),
            ]

            manifest = self._build_trace(
                agent_id="openhome-agent",
                description=f"Voice AI audit: {user_input[:100]}",
                events=events,
            )

            # Step 4: Submit to Orynq API
            result = await self._submit_to_orynq(manifest)

            # Step 5: Speak the result
            root_hash_short = manifest["rootHash"][-8:]

            if result and result.get("txHash"):
                response = self.capability_worker.text_to_text_response(
                    f"Summarize this in one short sentence for a voice "
                    f"response: An audit trail has been anchored to the "
                    f"Cardano blockchain. Transaction hash: "
                    f"{result['txHash']}. Root hash ending in "
                    f"{root_hash_short}. The record is now tamper-proof "
                    f"and independently verifiable using any Cardano "
                    f"block explorer."
                )
                await self.capability_worker.speak(response)
            elif result:
                response = self.capability_worker.text_to_text_response(
                    f"Summarize this in one short sentence for a voice "
                    f"response: Audit trail created with root hash ending "
                    f"in {root_hash_short}. It has been submitted for "
                    f"blockchain anchoring and will be independently "
                    f"verifiable once confirmed on-chain."
                )
                await self.capability_worker.speak(response)
            else:
                await self.capability_worker.speak(
                    "I built the audit trail locally, but couldn't submit "
                    "it to the blockchain right now. Please check your "
                    "Orynq API key and try again later."
                )

        except Exception as e:
            self.worker.editor_logging_handler.error(
                f"[OrynqAudit] Unexpected error: {e}"
            )
            await self.capability_worker.speak(
                "Sorry, something went wrong creating the audit trail. "
                "Please try again."
            )

        # ALWAYS resume normal flow on every exit path
        self.capability_worker.resume_normal_flow()
