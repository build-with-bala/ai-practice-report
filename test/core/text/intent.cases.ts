import type { Intent } from "../../../core/model/ids";

export const intentCases: [string, Intent][] = [
  ["/model opus", "command"], ["/clear", "command"], ["!git status", "command"], ["  /compact now", "command"],
  ["/review the diff", "command"], ["!ls -la", "command"],
  ["no, that's wrong — revert it", "correction"], ["nope", "correction"], ["That's not what I asked for", "correction"],
  ["undo that please", "correction"], ["still broken after your change", "correction"], ["didn't work, same error", "correction"],
  ["you broke the login page", "correction"], ["\"wrong file, try again\"", "correction"], ["not quite, the header is off", "correction"],
  ["actually, use postgres instead", "redirect"], ["wait, use the other endpoint", "redirect"], ["Stop. Let's take another approach", "redirect"],
  ["hold on, check the config first", "redirect"], ["scratch that, start over with sqlite", "redirect"], ["change of plan: ship it as a CLI", "redirect"],
  ["let's not touch the schema", "redirect"],
  ["continue", "continuation"], ["go on", "continuation"], ["keep going", "continuation"], ["Proceed", "continuation"],
  ["next", "continuation"], ["go ahead", "continuation"], ["resume please", "continuation"],
  ["lgtm", "ack"], ["thanks!", "ack"], ["ok", "ack"], ["yes", "ack"], ["perfect, thank you", "ack"], ["do it", "ack"], ["ship it", "ack"],
  ["", "ack"], ["   \n ", "ack"],
  ["why does the build fail?", "question"], ["How do I rotate the key", "question"], ["is this thread-safe", "question"],
  ["what does the retry wrapper do?", "question"], ["Could you explain the cache layout", "question"], ["where is the config loaded", "question"],
  ["Add a retry wrapper around fetchUser in src/api.ts; keep the signature and add tests", "spec"],
  ["Refactor the parser into two modules", "spec"], ["Implement pagination for the /users endpoint", "spec"],
  ["Rename the table and write a migration", "spec"], ["Please update the README with install steps", "spec"],
  ["Build a dashboard that lists sessions per day", "spec"], ["ok now add a retry wrapper around the fetch call in the client", "spec"],
];
