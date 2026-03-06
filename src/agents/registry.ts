import { AgentInfo } from '../types.js';
import { Blackboard } from '../blackboard/blackboard.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class AgentRegistry {
  private agents: Map<string, AgentInfo> = new Map();

  constructor(private blackboard: Blackboard) {}

  canSpawn(): boolean {
    // Persistent agents (e.g. Doorman) don't count toward maxAgents
    const slotAgents = Array.from(this.agents.values()).filter(a => !a.persistent);
    return slotAgents.length < config.maxAgents;
  }

  register(agent: AgentInfo): void {
    this.agents.set(agent.id, agent);
    this.blackboard.registerAgent(agent);
    logger.info({ id: agent.id, role: agent.role }, 'Agent registered');
  }

  update(id: string, updates: Partial<AgentInfo>): void {
    const agent = this.agents.get(id);
    if (!agent) {
      logger.warn({ id }, 'Attempted to update unknown agent');
      return;
    }
    Object.assign(agent, updates, { lastActivityAt: new Date().toISOString() });
    this.agents.set(id, agent);
    this.blackboard.updateAgent(id, updates);
  }

  remove(id: string): void {
    const existed = this.agents.delete(id);
    if (existed) {
      this.blackboard.removeAgent(id);
      logger.info({ id }, 'Agent removed');
    }
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  getRunning(): AgentInfo[] {
    return this.getAll().filter(a => a.status === 'working');
  }

  getByRole(role: string): AgentInfo[] {
    return this.getAll().filter(a => a.role === role);
  }

  count(): number {
    return this.agents.size;
  }
}
