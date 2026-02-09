# Changelog

All notable changes to the MultiAgentPoC project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- STATUS.md for tracking project progress and current state
- CHANGELOG.md for tracking project changes
- **Phase 0 - Scaffolding (Complete)**:
  - Root package.json with npm workspaces configuration
  - package.json for all 4 packages: shared, dispatcher, finance-agent, visa-agent
  - TypeScript configuration files (root tsconfig.json + per-package configs)
  - .env.example with all required environment variables
  - .gitignore with comprehensive exclusions for node_modules, dist, data, logs
  - data/ directory structure with subdirectories: logs/, finance/, visa/
  - src/ directory structure for all packages with placeholder TypeScript files
  - Placeholder implementations for shared package exports (logger, auth, health, types)

---

## [0.1.0] - 2026-02-09

### Added
- Initial project architecture and design documentation
- CLAUDE.md with project overview, architecture, commands, and development guidelines
- GEMINI.md with AI-specific instructions
- Multi-Agent-Design.md with detailed system design, implementation phases, and technical specifications
- GitHub repository setup with `main` and `CC-commit` branches
- Development workflow: CC-commit for all Claude Code commits, main for stable releases

### Project Structure
- Established monorepo architecture using npm workspaces
- Defined 3-container Pod structure: Dispatcher, Finance Agent, Visa Agent
- Designed async job queue with circuit breaker pattern
- Planned SQLite-based state management for Dispatcher
- Documented security architecture with multi-layer authentication

---

## Version History

- **0.1.0** (2026-02-09): Initial design and documentation phase
- **Unreleased**: Current development work

---

## Change Categories

This changelog uses the following categories:
- **Added**: New features or functionality
- **Changed**: Changes to existing functionality
- **Deprecated**: Features that will be removed in future versions
- **Removed**: Features that have been removed
- **Fixed**: Bug fixes
- **Security**: Security-related changes
