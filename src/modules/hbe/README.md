# hbe — Human Behavior Engine — Phase 2

Generates human-like timing, touch coordinates, and session patterns.
All logic is server-side. Devices execute, never decide.

## What goes here

- `hbe.service.ts` — main entry point for all HBE parameter generation
- `distributions.ts` — statistical distributions (normal, log-normal, uniform)
- `timing-profiles.ts` — per-action timing distributions (read pause, tap delay, etc.)
- `touch-jitter.ts` — Gaussian offset calculation for tap coordinates
- `scroll-velocity.ts` — natural acceleration/deceleration curves
- `session-patterns.ts` — daily session count/duration/timezone patterns
- `personality.ts` — per-account behavioral profiles (persistent across sessions)

## Core rules

- Never use `Math.random() * N` directly — always use proper distributions
- Timing parameters come from account's `personality_profile` (JSONB in DB)
- Each account has a "personality" seeded at creation and evolved over time
- Error simulation: occasional back navigation, accidental taps (configurable rate)

## Key distributions

| Behavior | Distribution | Typical params |
|----------|-------------|----------------|
| Read pause | Log-normal | mean=4000ms, σ=0.8 |
| Tap micro-pause | Normal | mean=700ms, σ=200ms |
| Scroll distance | Uniform | min=300px, max=800px |
| Touch jitter | Bivariate normal | σ=5-15px |
| Session duration | Log-normal | mean=8min, σ=1.0 |
