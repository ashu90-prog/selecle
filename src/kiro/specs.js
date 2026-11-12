import fs from 'node:fs';
import path from 'node:path';

// Kiro specs (kiro.dev/docs/specs): .kiro/specs/<name>/ holds requirements.md (user stories with
// EARS acceptance criteria), design.md and tasks.md (a checklist). selecle's Scribe spirit writes
// them; then one spirit per task builds the feature, ticking each task off as it lands.

export const SPECS_DIR = path.join('.kiro', 'specs');
export const SPEC_FILES = ['requirements.md', 'design.md', 'tasks.md'];
const MAX_TASKS = 20;

// A spec name as Kiro folders use it: kebab-case, short.
export const specSlug = (s) => String(s ?? '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// The top-level tasks of a tasks.md:
//   - [ ] 1. Title              (an unindented checkbox; "- [x]" is done, "- [ ]*" is optional)
//     - sub-steps and notes     (indented lines belong to the task above)
//     - _Requirements: 1.1, 2.3_
//     - _Spirit: tester_        (selecle's hint for which spirit should do it)
// Returns [{ number, title, done, optional, details: [lines], role }].
export function parseTasks(text) {
  const tasks = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const top = raw.match(/^[-*]\s+\[([ xX-])\](\*?)\s*(?:(\d+)[.)]?\s+)?(.+?)\s*$/);
    if (top) {
      tasks.push({
        number: top[3] ? Number(top[3]) : tasks.length + 1,
        title: top[4].replace(/^\*\s*/, ''),
        done: top[1].toLowerCase() === 'x',
        optional: top[2] === '*',
        details: [],
        role: null,
      });
      continue;
    }
    const task = tasks.at(-1);
    if (!task || !/^\s+\S/.test(raw)) continue;
    const role = raw.match(/_(?:spirit|role)\s*:\s*([a-z]+)_/i)?.[1]?.toLowerCase();
    if (role) task.role = role;
    else task.details.push(raw.trim());
  }
  // No hint: a title that is plainly tests-only or docs-only still gets the fitting spirit.
  for (const t of tasks) t.role ??= roleFromTitle(t.title);
  return tasks.slice(0, MAX_TASKS);
}

export function roleFromTitle(title) {
  const t = String(title).replace(/[`*_]/g, '');
  if (/^(write|add|create|update|extend|cover)\s+(the\s+)?(unit\s+|integration\s+)?tests?\b/i.test(t) || /^tests?\s+(for|of)\b/i.test(t)) return 'tester';
  if (/^(write|add|create|update|document)\s+(the\s+)?(readme|docs?|documentation|changelog|guide)\b/i.test(t) || /^document\b/i.test(t)) return 'chronicler';
  return null;
}

// How many requirements a requirements.md has ("### Requirement 3: ..." headings).
export const countRequirements = (text) => (String(text ?? '').match(/^#{2,4}\s*Requirement\b/gim) ?? []).length;

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

// One spec folder, read: { name, dir, files: { requirements, design, tasks } (text or null),
// requirements: count, tasks: [...], done, total }.
export function readSpec(root, name) {
  const dir = path.join(root, SPECS_DIR, name);
  const files = Object.fromEntries(SPEC_FILES.map((f) => [f.replace('.md', ''), read(path.join(dir, f))]));
  const tasks = parseTasks(files.tasks);
  const counted = tasks.filter((t) => !t.optional);
  return {
    name,
    dir,
    files,
    requirements: countRequirements(files.requirements),
    tasks,
    done: counted.filter((t) => t.done).length,
    total: counted.length,
  };
}

// Every spec in the project, by name. A missing folder is an empty list.
export function listSpecs(root) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, SPECS_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return names.map((name) => readSpec(root, name)).filter((s) => Object.values(s.files).some((t) => t !== null));
}

// One line per spec for the Crypt and /spec: "dark-mode: 3 requirements, tasks 2/5 done".
export function specLine(spec) {
  const has = SPEC_FILES.filter((f) => spec.files[f.replace('.md', '')] !== null).map((f) => f.replace('.md', ''));
  const tasks = spec.total ? `tasks ${spec.done}/${spec.total} done` : 'no tasks yet';
  const missing = SPEC_FILES.length - has.length;
  return `${spec.name}: ${spec.requirements} requirement${spec.requirements === 1 ? '' : 's'}, ${tasks}${missing ? ` (missing ${SPEC_FILES.filter((f) => !has.includes(f.replace('.md', ''))).join(', ')})` : ''}`;
}

// The task a Scribe spirit is given.
export function scribeTask(name, request) {
  return `Write the Kiro spec "${name}" in .kiro/specs/${name}/ (requirements.md, design.md, tasks.md) for this request: ${request}\nIf that folder already has files, revise them to fit the request instead of starting over, and keep ticked tasks ticked.`;
}

// The task one building spirit is given: one task of the spec, with where to read the rest.
export function buildTask(spec, task) {
  const steps = task.details.length ? `\n${task.details.map((d) => `  ${d}`).join('\n')}` : '';
  return [
    `Do task ${task.number} of the Kiro spec "${spec.name}" (.kiro/specs/${spec.name}/): ${task.title}${steps}`,
    `Read .kiro/specs/${spec.name}/requirements.md and design.md first and follow them. Do only this task; later tasks belong to other spirits.`,
    `When it is done, tick it in .kiro/specs/${spec.name}/tasks.md: change "- [ ] ${task.number}." to "- [x] ${task.number}." and change nothing else in that file.`,
  ].join('\n');
}
