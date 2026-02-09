/**
 * Shared TypeScript interfaces
 * TODO: Implement in Phase 1
 */

export interface TaskRequest {
  prompt: string;
  context?: any;
}

export interface TaskResponse {
  result: string;
  tokens_used: number;
  charts?: string[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime_seconds: number;
  memory_usage_mb: number;
  version: string;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
