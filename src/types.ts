// --- Channel abstraction ---
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  setTyping?(active: boolean): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export type OnInboundMessage = (message: UserMessage) => void;

// --- Messages ---
export interface UserMessage {
  id: string;
  channelId: string;    // e.g. "cli:0", "tg:12345"
  sender: string;
  content: string;
  timestamp: string;
}

// --- Tasks ---
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRole = 'coder' | 'researcher' | 'writer' | 'general';

export interface Task {
  id: string;
  prompt: string;
  role: AgentRole;
  status: TaskStatus;
  agentId: string | null;
  result: string | null;
  error: string | null;
  executor?: string;       // preferred executor (e.g. 'claude-code'), null = use skill default
  parentTaskId?: string;   // links to previous task in multi-turn chain
  sessionId?: string;      // claude-code session ID for --resume
  source?: string;         // who created: 'user', 'agent:<id>', 'scheduler', 'api'
  createdAt: string;
  updatedAt: string;
}

// --- Notes (informational, don't trigger agent spawn) ---
export interface Note {
  id: string;
  source: string;          // who created: agent id, 'user', 'scheduler'
  title: string;
  content: string;
  tags?: string;           // comma-separated tags for filtering
  taskId?: string;         // optional link to a task
  createdAt: string;
}

// --- Agents ---
export type AgentStatus = 'idle' | 'working' | 'stopping' | 'stopped';

export interface AgentInfo {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  currentTaskId: string | null;
  pid: number | null;
  startedAt: string;
  lastActivityAt: string;
  executor?: string;       // 'llm' | 'claude-code'
  outputBytes?: number;
  persistent?: boolean;    // persistent agents don't count toward maxAgents slot limit
}

// --- Feed entries (activity log) ---
export type FeedType = 'user_message' | 'doorman_response' | 'agent_spawned' | 'agent_progress' | 'agent_result' | 'agent_error' | 'agent_killed' | 'system';

export interface FeedEntry {
  id: string;
  type: FeedType;
  source: string;       // who generated it: "doorman", agent id, "system"
  content: string;
  taskId: string | null;
  timestamp: string;
}

// --- Approvals ---
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  taskId: string;
  description: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

// --- Blackboard state snapshot ---
export interface BlackboardState {
  tasks: Task[];
  agents: AgentInfo[];
  feeds: FeedEntry[];
  approvals: Approval[];
  notes: Note[];
}

// --- Scheduled tasks (proactive) ---
export interface ScheduledTask {
  id: string;
  cron: string;           // cron expression (e.g. "0 9 * * *" for 9am daily)
  prompt: string;
  executor?: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

// --- Classifier result ---
export type Intent =
  | { type: 'kill'; targetId?: string }
  | { type: 'status' }
  | { type: 'approval'; approve: boolean; approvalId?: string }
  | { type: 'task'; role: AgentRole; prompt: string; executor?: string; continueFrom?: string }
  | { type: 'chat'; content: string };

// --- Skill ---
export interface Skill {
  name: string;
  description: string;
  content: string;      // full SKILL.md body
  baseDir: string;      // resolved absolute path
  executor?: string;    // which executor to use: 'llm', 'claude-code', etc. defaults to 'llm'
  model?: string;       // optional model override for this skill
}

// --- Config ---
export interface MeridianConfig {
  port: number;
  dataDir: string;
  skillsDir: string;
  maxAgents: number;
  agentTimeoutMs: number;
  model: string;
  claudeCliPath?: string;
  schedules?: ScheduledTask[];
}

// --- WebSocket messages (A2UI protocol) ---
export type WsOutMessage =
  | { type: 'state'; data: BlackboardState }
  | { type: 'feed'; data: FeedEntry }
  | { type: 'task_update'; data: Task }
  | { type: 'agent_update'; data: AgentInfo }
  | { type: 'approval_request'; data: Approval };

export type WsInMessage =
  | { type: 'message'; content: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string };
