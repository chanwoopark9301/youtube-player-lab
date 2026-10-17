# Conversational Video Assistant Implementation Plan

> **For agentic workers:** Use executing-plans for integration; independent adapters and session storage use subagents.

**Goal:** Support conversational recommendations, switching the visible player, and answers grounded in its actual captions.
**Architecture:** The model uses accessible conversation context. The server supplies public search/caption evidence and isolated player control/observations. No full chat collection or separate AI provider.
**Tech Stack:** Existing Node >=20, MCP Apps SDK, zod, native fetch.
**Spec:** ../specs/2026-10-17-conversational-video-assistant.md

## Global Constraints

- No video/audio download, login/challenge/IP-block bypass, paid service, Gemini, or full conversation storage.
- Preserve the clean layout, referrer fix, and external navigation.
- Browser reporting keys belong only in UI `_meta`; model control references cannot forge player reports.
- Bind content evidence to video ID and revision. Requested playback is not observed playback.

## Review Focus

- Delayed reports/captions from A must not become the state/content of B.
- Old external/embedded windows must detach when a new player takes ownership.
- Partial transcript pages and network blocks must not look like full transcript success.
- Public HTML/JSON changes, invalid IDs, empty results and timeouts must return bounded explicit errors.
- Browser autoplay denial, mobile sleep, session expiry and server restart require honest unconfirmed/disconnected states.

## Tasks

1. [x] `lib/player-sessions.js`, `test/player-sessions.test.mjs`: TDD isolated expiring capabilities, commands, observed state, ownership epochs and ACK validation.
2. [x] `lib/youtube-search.js`, `lib/youtube-transcript.js`, corresponding tests: TDD actual public text paths, validated IDs, size/time bounds, provenance, failure classification. Live local probes for two captioned videos and search.
3. [x] `server.js`, `test/assistant-tools.test.mjs`: TDD MCP search/transcript/open/control/state tools and same-origin browser API; pagination and stale-video protection.
4. [x] `public/session-client.js`, existing HTML, client tests: TDD actual YouTube state/time reports, select/play/pause/seek, and external-window handoff.
5. [ ] Run full tests/checks, independent review, push main for auto deployment; verify Render-issued search/captions and actual Mac playback/switching.
6. [ ] Test content Q&A and contextual recommendation against real returned sources. Obtain actual mobile verification separately; keep goal active until all requirements are proved.

## Ledger

- Dedicated task clone, feature branch `feat/conversational-video-assistant` from `77bc468`.
- Ruling: Gemini onboarding removed following the user's rejection. Direct captions are the content source; failures remain explicit.
- Ruling: Existing clone is already isolated to this task; no additional checkout is needed.
- Independent review found three defects, each reproduced RED and fixed GREEN: select→pause race, oversized first caption cue, and stale error after playback recovery. Full suite 88/88 and syntax/whitespace checks passed on 2026-10-17.
- Local actual browser currently shows a blank new YouTube iframe for both the new code and the previous production baseline. Existing previously opened production player still displays video. Do not treat simulated client tests as successful actual playback.
- Ruling: replace the unnecessary video watch-page request with the normal public `/sw.js_data` bootstrap, retaining one player client and stopping on blocks. The global public key is the only watch-page value consumed. No alternate client retries or access-check workarounds.
- Local bootstrap implementation passed 93/93 tests, plus actual two-video Node 20 HTTP checks (466 and 6 caption cues). Render verification remains a deployment gate.
- MCP connector now exposes all five tools. In the existing native Mac card, an actual play command was acknowledged and reported `playing` at 12.28, 14.98 and 18.79 seconds. This supersedes the earlier short automatic-play observation for this tested play command; it does not explain that earlier pause or establish mobile behavior.
- `f3f59de` fixes delayed host tool results overriding a newer server-selected video. Independent regression review passed. Recommendation-list identities and content acquisition/coverage metadata remain implementation gaps against the spec.
- The user confirmed the latest native Mac card plays continuously for more than five seconds after a foreground YouTube Play click.
- Render deployed `3c8f491` as `dep-db9o1mbm8hqs73amcsn0` live. Both actual transcript tool calls now fail with `blocked` at `player`, not bootstrap; no additional client/fallback was attempted.
- Connected vidIQ returned real English transcript text for `jNQXAC9IVRw` with 5 existing credits. It provides no timestamps in this response; those must not be invented. This is separate from direct Render extraction.
- Recommendation lists now retain an expiring random identity and fixed item numbers. Numbered select resolves the explicit list/item before queueing; partial pairs, wrong actions and conflicting video IDs are rejected. Captions expose acquisition time and returned-page time range. Independent review found no blocking defect; 105/105 tests and syntax/whitespace checks pass. Live verification follows deployment.
