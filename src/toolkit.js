// The prompt toolkit: ready-made requests for the Crypt. Type / in the chat and
// they appear next to the commands; picking one puts it in the box to edit.
//
// A prompt may mention {file}: it becomes the file selected in the tree, or
// "the project" when nothing is selected.

export const PROMPTS = [
  { title: 'Fix a bug', text: 'There is a bug in {file}. Find the cause and fix it.' },
  { title: 'Write tests', text: 'Write tests for {file}, covering the normal cases and the edge cases.' },
  { title: 'Explain', text: 'Explain what {file} does, simply, and point out anything risky.' },
  { title: 'Refactor', text: 'Refactor {file} to be simpler and clearer without changing what it does.' },
  { title: 'Add docs', text: 'Add short, useful comments and a usage note to {file}.' },
  { title: 'Review', text: 'Review {file} for bugs, missing error handling and unclear names. Do not change anything, just tell me.' },
  { title: 'Find TODOs', text: 'Find every TODO and FIXME in {file} and raise a spirit for each one that is quick to do.' },
  { title: 'Split the work', text: 'Break this into small independent tasks and raise one spirit for each: ' },
];

export const fillPrompt = (text, file) => text.replaceAll('{file}', file || 'the project');
