import { ROLES, ROLE_NAMES, agentName, agentsDir, ensureAgents, installAgents } from './agents.js';
import { readSteering } from './steering.js';
import { listSpecs, specLine } from './specs.js';
import { kitPlan } from './kit.js';

// What Kiro sees in a project, as plain lines: the spirit agents, the steering the spirits
// follow, the specs and their progress, and how to add the séance to your own Kiro.
// `install` writes the agents first (the CLI does; the app relies on ensureAgents()).
export function kiroReport(root, { install = true } = {}) {
  let agents;
  if (install) {
    try {
      const r = installAgents();
      agents = `Spirit agents in ${r.dir}${r.written.length ? ` (just written: ${r.written.join(', ')})` : ''}:`;
    } catch (e) {
      agents = `Could not write the spirit agents to ${agentsDir()}: ${e.message}`;
    }
  } else {
    agents = ensureAgents() ? `Spirit agents in ${agentsDir()}:` : 'Spirit agents are off; spirits run as plain Kiro with file tools.';
  }
  const steering = readSteering(root);
  const specs = listSpecs(root);
  return [
    agents,
    ...ROLE_NAMES.map((r) => `  ${agentName(r).padEnd(18)} ${ROLES[r].blurb}${ROLES[r].write ? ` (writes only ${ROLES[r].write.slice(0, 3).join(', ')}${ROLES[r].write.length > 3 ? ', …' : ''})` : ''}`),
    `  ${agentName('crypt').padEnd(18)} the Crypt: talks only, no tools`,
    '',
    steering.length
      ? `Steering every spirit follows (.kiro/steering): ${steering.map((f) => `${f.file}${f.inclusion !== 'always' ? ` (${f.inclusion})` : ''}`).join(', ')}`
      : 'No steering yet. Add Markdown files to .kiro/steering/ and every spirit and the Crypt follows them.',
    '',
    specs.length ? 'Specs (.kiro/specs):' : 'No specs yet. Ask the Crypt for a feature, or type /spec <feature>, and the Scribe writes one.',
    ...specs.map((s) => `  ${specLine(s)}`),
    '',
    kitStatus(root),
  ].join('\n');
}

function kitStatus(root) {
  const plan = kitPlan(root);
  const has = (f) => plan.some((s) => s.file.replace(/\\/g, '/').endsWith(f) && (s.state === 'ok' || s.state === 'kept'));
  if (plan.every((s) => s.state === 'ok')) return 'Kiro kit: in this project (séance, selecle steering, hooks). Your own Kiro knows the room.';
  const parts = [has('mcp.json') && 'séance', has('selecle.md') && 'steering', has('selecle.json') && 'hooks'].filter(Boolean);
  return `Kiro kit: ${parts.length ? `partly here (${parts.join(', ')})` : 'not in this project yet'}. /init (or selecle init) adds it, so your own Kiro knows the room.`;
}
