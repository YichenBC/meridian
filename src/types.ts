// --- Channel abstraction ---
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(text: string, targetChannelId?: string): Promise<void>;
  setTyping?(active: boolean, targetChannelId?: string): Promise<void>;
  setReaction?(messageId: number, emoji: string, targetChannelId?: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export type OnInboundMessage = (message: UserMessage) => void;

// --- Attachments ---
export interface Attachment {
  path: string;         // absolute local path to downloaded file
  contentType: string;  // MIME type: image/jpeg, application/pdf, etc.
  fileName?: string;    // original filename if available
  size?: number;        // bytes
}

// --- Messages ---
export interface UserMessage {
  id: string;
  channelId: string;    // e.g. "cli:0", "tg:12345"
  sender: string;
  content: string;
  attachments?: Attachment[];
  sourceMessageId?: number;  // platform message ID (e.g. Telegram message_id) for reactions/edit tracking
  isEdit?: boolean;          // true when this is an edited message replacing a previous one
  timestamp: string;
}

// --- Tasks ---
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  prompt: string;
  role: string;            // free-form role hint (not hardcoded)
  status: TaskStatus;
  agentId: string | null;
  result: string | null;
  error: string | null;
  executor?: string;       // preferred executor (e.g. 'claude-code'), null = use skill default
  model?: string;          // model override for this task (e.g. 'haiku', 'opus'), null = use config default
  parentTaskId?: string;   // links to previous task in multi-turn chain
  sessionId?: string;      // claude-code session ID for --resume
  source?: string;         // who created: routeable channelId or 'agent:<id>' / 'scheduler' / 'api'
  blockedBy?: string[];    // task IDs that must complete before this task can run (DAG)
  priority?: number;       // higher = more important, default 0
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
  role: string;
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

// --- Session pool ---
export interface Session {
  id: string;              // e.g. "session-abc123"
  sessionId: string;       // Claude CLI session_id (for --resume)
  domain: string;          // e.g. "knowledge", "system", "research", "general"
  summary: string;         // 1-2 sentence summary of what this session knows
  tags: string | null;     // comma-separated: "vault,obsidian,papers,OPD"
  taskCount: number;       // how many tasks this session has handled
  lastUsedAt: string;
  createdAt: string;
}

// --- Blackboard state snapshot ---
export interface BlackboardState {
  tasks: Task[];
  agents: AgentInfo[];
  feeds: FeedEntry[];
  approvals: Approval[];
  notes: Note[];
}


// --- Skill ---
export interface Skill {
  name: string;
  description: string;
  content: string;      // full SKILL.md body
  baseDir: string;      // resolved absolute path
  sourceDir: string;    // directory where the skill was discovered
  install?: SkillInstallMetadata;
  executor?: string;    // which executor to use: 'llm', 'claude-code', etc. defaults to 'llm'
  model?: string;       // optional model override for this skill
  openclaw?: {
    always?: boolean;
    os?: string[];
    skillKey?: string;
    primaryEnv?: string;
    requires?: {
      bins?: string[];
      anyBins?: string[];
      env?: string[];
      config?: string[];
    };
  };
  eligibility: {
    eligible: boolean;
    missing: string[];
    satisfied: string[];
    source: 'none' | 'openclaw';
  };
}

export interface SkillInstallMetadata {
  installer: 'meridian';
  installedAt: string;
  source: {
    kind: 'local-path' | 'extra-skills-dir' | 'clawhub';
    reference: string;
    resolvedPath?: string;
    slug?: string;
    downloadedVia?: 'clawhub';
  };
}

// --- Permission modes ---
export type AuditorMode = 'passthrough' | 'constitutional' | 'supervised';
export type CodexExecutionMode = 'subprocess' | 'host-bridge';

// --- Config ---
export interface MeridianConfig {
  port: number;
  dataDir: string;
  skillsDir: string;
  extraSkillsDirs: string[];
  maxAgents: number;
  agentTimeoutMs: number;
  model: string;
  claudeCliPath?: string;
  codexCliPath?: string;
  codexExecutionMode: CodexExecutionMode;
  codexHostBridgeUrl?: string;
  codexHostBridgeToken?: string;
  codexHostBridgeTimeoutMs: number;
  doormanExecutor?: string; // "claude-code" | "codex-cli"
  toolExecutor?: string;   // default tool-capable executor for delegated action tasks
  auditorMode: AuditorMode;
  auditorOverrides: Record<string, AuditorMode>;
  apiToken?: string;          // bearer token for /api/* endpoints (optional)
}

// --- WebSocket messages (A2UI protocol) ---
export type WsOutMessage =
  | { type: 'state'; data: BlackboardState }
  | { type: 'feed'; data: FeedEntry }
  | { type: 'task_update'; data: Task }
  | { type: 'agent_update'; data: AgentInfo }
  | { type: 'approval_request'; data: Approval }
  | { type: 'note'; data: Note };

export type WsInMessage =
  | { type: 'message'; content: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string };
