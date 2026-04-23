# Pricing Accuracy Architecture

Date: 2026-03-16

## Goal

Hermes should only show dollar costs when they are backed by an official source for the user's actual billing path.

This design replaces the current static, heuristic pricing flow in:

- `run_agent.py`
- `agent/usage_pricing.py`
- `agent/insights.py`
- `cli.py`

with a provider-aware pricing system that:

- handles cache billing correctly
- distinguishes `actual` vs `estimated` vs `included` vs `unknown`
- reconciles post-hoc costs when providers expose authoritative billing data
- supports direct providers, OpenRouter, subscriptions, enterprise pricing, and custom endpoints

## Problems In The Current Design

Current Hermes behavior has four structural issues:

1. It stores only `prompt_tokens` and `completion_tokens`, which is insufficient for providers that bill cache reads and cache writes separately.
2. It uses a static model price table and fuzzy heuristics, which can drift from current official pricing.
3. It assumes public API list pricing matches the user's real billing path.
4. It has no distinction between live estimates and reconciled billed cost.

## Design Principles

1. Normalize usage before pricing.
2. Never fold cached tokens into plain input cost.
3. Track certainty explicitly.
4. Treat the billing path as part of the model identity.
5. Prefer official machine-readable sources over scraped docs.
6. Use post-hoc provider cost APIs when available.
7. Show `n/a` rather than inventing precision.

## High-Level Architecture

The new system has four layers:

1. `usage_normalization`
   Converts raw provider usage into a canonical usage record.
2. `pricing_source_resolution`
   Determines the billing path, source of truth, and applicable pricing source.
3. `cost_estimation_and_reconciliation`
   Produces an immediate estimate when possible, then replaces or annotates it with actual billed cost later.
4. `presentation`
   `/usage`, `/insights`, and the status bar display cost with certainty metadata.
