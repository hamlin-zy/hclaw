-- Migration: 028_drop_agents_table
-- Removes unused agents table - agent state is managed via agent_overrides
-- Created: 2026-07-14

DROP TABLE IF EXISTS agents;
