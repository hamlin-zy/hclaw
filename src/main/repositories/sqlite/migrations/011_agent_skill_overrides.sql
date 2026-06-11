-- Migration: 003_agent_skill_overrides
-- Adds tables for agent and skill override states (replaces JSON file storage)
-- Created: 2026-06-26

CREATE TABLE IF NOT EXISTS agent_overrides (
    agent_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_overrides (
    skill_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);
