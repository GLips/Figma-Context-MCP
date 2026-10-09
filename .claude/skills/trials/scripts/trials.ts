#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import init from "./commands/init.ts";
import interview from "./commands/interview.ts";
import list from "./commands/list.ts";
import report from "./commands/report.ts";
import run from "./commands/run.ts";

const main = defineCommand({
  meta: {
    name: "trials",
    description:
      "Run naive-agent design trials against the framelink MCP: spawn, interview, report.",
  },
  subCommands: { init, list, run, interview, report },
});

runMain(main);
